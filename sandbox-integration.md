Apologies for the Hindi response earlier. Let me break this down clearly in English.

---

## The Core Problem

Your `dhanhq-client` gem currently supports **only one global configuration** (single base URL + credentials). You need your single Rails app to:
- Use **real environment** for market data + WebSocket connections
- Use **sandbox environment** for paper trading (orders, etc.)

Since some APIs don't exist in sandbox and WebSocket likely doesn't work there, you need **both environments active simultaneously** in one application.

---

## Solution Options

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| **A: Two App Instances** | Deploy 2 Rails apps with different env vars | Simple, no code changes | Wasteful, hard to sync data, complex to manage |
| **B: Extend the Gem (Recommended)** | Refactor gem to support multiple client instances | Clean, single app, flexible routing | Requires gem changes |
| **C: Wrapper Gem** | Create a new gem that internally manages two DhanHQ instances | Keeps original gem untouched, easier upgrades | Adds abstraction layer |

---

## Recommended: Option B – Extend the Gem

Refactor your `dhanhq-client` gem to support **per-instance configuration** rather than global state.

### Step 1: Refactor the Gem

**Before (global config):**
```ruby
DhanHQ.configure do |c|
  c.client_id = ENV["DHAN_CLIENT_ID"]
  c.access_token = ENV["DHAN_ACCESS_TOKEN"]
  c.base_url = "https://api.dhan.co/v2"
end

# Everything uses this single config
order = DhanHQ::Order.create(...)
```

**After (instance-based):**
```ruby
# Configuration becomes a plain object
config = DhanHQ::Configuration.new do |c|
  c.client_id = "..."
  c.access_token = "..."
  c.base_url = "..."
end

# Client accepts config on initialization
client = DhanHQ::Client.new(config)
order = client.orders.create(...)  # All API calls use this client's config
```

### Step 2: Setup in Rails Initializer

```ruby
# config/initializers/dhan_hq.rb

REAL_CONFIG = DhanHQ::Configuration.new do |c|
  c.client_id = ENV["DHAN_REAL_CLIENT_ID"]
  c.access_token = ENV["DHAN_REAL_ACCESS_TOKEN"]
  c.base_url = "https://api.dhan.co/v2"
end

SANDBOX_CONFIG = DhanHQ::Configuration.new do |c|
  c.client_id = ENV["DHAN_SANDBOX_CLIENT_ID"]
  c.access_token = ENV["DHAN_SANDBOX_ACCESS_TOKEN"]
  c.base_url = "https://sandbox.dhan.co/v2"
end

# Create two global clients (or use $dhan_real / $dhan_sandbox)
DHAN_REAL = DhanHQ::Client.new(REAL_CONFIG)
DHAN_SANDBOX = DhanHQ::Client.new(SANDBOX_CONFIG)
```

### Step 3: Use in Your Trading Logic

```ruby
# Real environment → market data + WebSocket
market_data = DHAN_REAL.market_feed.subscribe(symbols: ["RELIANCE"])
websocket = DHAN_REAL.websocket.connect  # Works here

# Sandbox environment → paper trading
order = DHAN_SANDBOX.orders.create(
  symbol: "RELIANCE",
  quantity: 10,
  side: "BUY"
)  # Uses sandbox URL + credentials automatically

# If a sandbox API doesn't exist, catch it gracefully
begin
  DHAN_SANDBOX.some_unsupported_endpoint
rescue DhanHQ::SandboxNotSupportedError
  # Fallback to real or log
end
```

---

## Alternative: Option C – Wrapper Gem

If you don't want to modify your published gem, create a `dhanhq-multi` gem:

```ruby
# lib/dhanhq_multi.rb
class DhanHQMulti
  def initialize(real_config, sandbox_config)
    @real = DhanHQ::Client.new(real_config)
    @sandbox = DhanHQ::Client.new(sandbox_config)
  end

  def market_data
    @real  # Real for WebSocket/market data
  end

  def trading
    @sandbox  # Sandbox for orders/paper trading
  end

  # Smart routing: auto-detect based on method
  def method_missing(method, *args, &block)
    if market_data_methods.include?(method)
      @real.send(method, *args, &block)
    elsif trading_methods.include?(method)
      @sandbox.send(method, *args, &block)
    else
      super
    end
  end
end
```

---

## Important Considerations for Sandbox

| Aspect | Real | Sandbox |
|--------|------|---------|
| **WebSocket** | ✅ Supported | ❌ Likely not supported |
| **All APIs** | ✅ Full set | ⚠️ Subset (check docs) |
| **Credentials** | Separate from real | Separate from real |
| **Order Execution** | Real money | Paper trades only |
| **Data Latency** | Real-time | May be delayed/stale |

**Action Items:**
1. Check DhanHQ's official docs for the exact sandbox API list.
2. Implement a `sandbox_supported?` check in your gem for graceful fallback.
3. Store credentials in Rails credentials (`config/credentials.yml.enc`) for security.

---

## Final Recommendation

**Go with Option B (extend the gem).** It's the cleanest architecture for a trading system where you need both environments in one process. The refactoring effort is worthwhile—it makes your gem more professional and flexible for all future use cases.

Would you like me to provide a more detailed implementation plan for the gem refactoring or help with any specific part of the integration?

## Detailed Upgrade Plan – Option B: Extend the Gem for Multi‑Instance Support

This plan outlines how to refactor your `dhanhq-client` gem to support **multiple isolated clients** (real and sandbox) within a single Rails application. The goal is to keep the gem clean, maintain backward compatibility for existing users, and provide a smooth migration path.

---

### Phase 0: Assessment & Compatibility Check

1. **Review the current gem structure**
   - Identify all places where global state (e.g., `DhanHQ.configuration`, class variables) is used.
   - List all public API methods (e.g., `DhanHQ::Order.create`, `DhanHQ::MarketFeed.subscribe`).
   - Note any singleton patterns, `attr_accessor` on the module, or `@@` class variables.

2. **Understand sandbox limitations**
   - Which endpoints are **not** supported in sandbox? (Check official docs.)
   - Is WebSocket **completely unavailable** or just restricted?
   - Will sandbox return specific error codes we can rescue?

3. **Decide versioning strategy**
   - If you keep both global and instance APIs (with deprecation warnings) → **minor** version bump (e.g., 2.0 → 2.1).
   - If you remove global APIs entirely → **major** version bump (3.0).
   **Recommendation:** Keep global APIs for backward compatibility, but deprecate them. This gives existing users time to migrate.

---

### Phase 1: Gem Refactoring – Core Changes

#### 1.1 Create a `Configuration` Class (Instance-based)

Move all configuration attributes (client_id, access_token, base_url, timeout, etc.) into a plain Ruby object.

```ruby
# lib/dhanhq/configuration.rb
module DhanHQ
  class Configuration
    attr_accessor :client_id, :access_token, :base_url, :timeout, :sandbox_mode

    def initialize
      # set defaults
      @base_url = "https://api.dhan.co/v2"
      @timeout = 30
      @sandbox_mode = false
      yield(self) if block_given?
    end
  end
end
```

#### 1.2 Create a `Client` Class

The `Client` holds a configuration and is responsible for making HTTP requests and instantiating resource objects (orders, market feed, etc.).

```ruby
# lib/dhanhq/client.rb
module DhanHQ
  class Client
    attr_reader :config, :connection

    def initialize(config = nil)
      @config = config || DhanHQ.configuration  # fallback to global config
      @connection = Faraday.new(@config.base_url) do |faraday|
        faraday.headers["X-Client-Id"] = @config.client_id
        faraday.headers["X-Access-Token"] = @config.access_token
        faraday.request :json
        faraday.response :json
        faraday.adapter Faraday.default_adapter
      end
    end

    # Resource accessors – each returns a resource object that uses this client
    def orders
      @orders ||= Resources::Orders.new(self)
    end

    def market_feed
      @market_feed ||= Resources::MarketFeed.new(self)
    end

    def websocket
      @websocket ||= Resources::WebSocket.new(self)
    end

    # Generic request method (used by resources)
    def request(method, path, params = nil)
      response = @connection.public_send(method, path) do |req|
        req.params = params if params && method == :get
        req.body = params.to_json if params && method != :get
      end
      handle_response(response)
    end

    private

    def handle_response(response)
      # Raise errors based on status, parse body, etc.
    end
  end
end
```

#### 1.3 Refactor Resource Classes (Orders, MarketFeed, etc.)

Change resource classes to accept a `client` instance instead of using global `DhanHQ.configuration`.

**Before:**
```ruby
module DhanHQ
  class Order
    def self.create(params)
      # uses DhanHQ.configuration directly
    end
  end
end
```

**After:**
```ruby
module DhanHQ
  module Resources
    class Orders
      def initialize(client)
        @client = client
      end

      def create(params)
        @client.request(:post, "/orders", params)
      end

      def all
        @client.request(:get, "/orders")
      end
      # ... other methods
    end
  end
end
```

**Important:** Do not change the public interface of existing classes yet – we will keep the old class methods as proxies.

#### 1.4 Keep Global Configuration for Backward Compatibility

Maintain the old `DhanHQ.configure` block and a global default client.

```ruby
# lib/dhanhq.rb
module DhanHQ
  class << self
    attr_writer :configuration

    def configuration
      @configuration ||= Configuration.new
    end

    def configure
      yield(configuration)
    end

    # Global default client (used by old class methods)
    def default_client
      @default_client ||= Client.new(configuration)
    end

    # Allow resetting default client (useful in tests)
    def reset_default_client!
      @default_client = nil
    end
  end
end
```

#### 1.5 Provide Proxy Methods in Old Classes (Deprecated)

For each resource class, add methods that delegate to the default client’s resource instance.

```ruby
# lib/dhanhq/order.rb (the old top-level class)
module DhanHQ
  class Order
    # Deprecated – use DhanHQ::Client.new.orders.create instead
    def self.create(params)
      DhanHQ.deprecate("DhanHQ::Order.create is deprecated; use client.orders.create")
      DhanHQ.default_client.orders.create(params)
    end

    def self.all
      DhanHQ.deprecate("DhanHQ::Order.all is deprecated; use client.orders.all")
      DhanHQ.default_client.orders.all
    end
    # ...
  end
end
```

Add a `DhanHQ.deprecate` helper that logs a warning (e.g., using `ActiveSupport::Deprecation` in Rails or `warn`).

---

### Phase 2: WebSocket Handling

WebSocket connections are stateful and per-client. Ensure the `WebSocket` resource uses the client’s credentials and base URL.

```ruby
# lib/dhanhq/resources/websocket.rb
module DhanHQ
  module Resources
    class WebSocket
      def initialize(client)
        @client = client
      end

      def connect
        # Build WebSocket URL from @client.config.base_url (replace https with wss)
        ws_url = @client.config.base_url.gsub(/^https/, 'wss') + "/ws"
        # Use a WebSocket library (e.g., websocket-driver, async-websocket)
        # Pass client_id and access_token in the connection headers or query params
        # ...
      end
    end
  end
end
```

**Sandbox Note:** The sandbox may not support WebSocket. You can add a `sandbox_supported?` check in the connect method:

```ruby
def connect
  raise SandboxNotSupportedError, "WebSocket is not supported in sandbox" if @client.config.sandbox_mode
  # ... rest
end
```

---

### Phase 3: API Endpoint Support in Sandbox

Create a mapping of supported endpoints in sandbox. You can add a `supported_in_sandbox?` method to each resource or a central registry.

```ruby
# lib/dhanhq/sandbox_support.rb
module DhanHQ
  module SandboxSupport
    SUPPORTED_ENDPOINTS = {
      orders: [:create, :all, :cancel],
      # market_feed: []  # none supported?
    }

    def sandbox_supported?(resource, method)
      SUPPORTED_ENDPOINTS.dig(resource, method) || false
    end
  end
end
```

In your resource methods, you can check and raise a friendly error:

```ruby
def create(params)
  if @client.config.sandbox_mode && !SandboxSupport.sandbox_supported?(:orders, :create)
    raise SandboxNotSupportedError, "Orders#create is not available in sandbox"
  end
  @client.request(:post, "/orders", params)
end
```

---

### Phase 4: Testing

1. **Unit tests for `Configuration`** – ensure it holds values and can be cloned.
2. **Unit tests for `Client`** – stub Faraday and test request building, headers, error handling.
3. **Unit tests for resource classes** – test that they call `client.request` with correct arguments.
4. **Integration tests** – use VCR or WebMock to test against real sandbox/real endpoints (optional).
5. **Backward compatibility tests** – ensure the old `DhanHQ::Order.create` still works (using default client) and emits deprecation warning.

---

### Phase 5: Migration Guide for Gem Users

Write a clear migration guide in the gem’s README:

- **For new users:** Recommend using `DhanHQ::Client.new(config)`.
- **For existing users:** Explain that the old global methods are deprecated and will be removed in the next major version.
- Provide examples for single-client and dual-client (real+sandbox) setups.

---

### Phase 6: Rails Integration (as you described)

Once the gem is updated, the Rails initializer becomes:

```ruby
# config/initializers/dhan_hq.rb
REAL_CONFIG = DhanHQ::Configuration.new do |c|
  c.client_id = ENV["DHAN_REAL_CLIENT_ID"]
  c.access_token = ENV["DHAN_REAL_ACCESS_TOKEN"]
  c.base_url = "https://api.dhan.co/v2"
  c.sandbox_mode = false
end

SANDBOX_CONFIG = DhanHQ::Configuration.new do |c|
  c.client_id = ENV["DHAN_SANDBOX_CLIENT_ID"]
  c.access_token = ENV["DHAN_SANDBOX_ACCESS_TOKEN"]
  c.base_url = "https://sandbox.dhan.co/v2"
  c.sandbox_mode = true
end

DHAN_REAL = DhanHQ::Client.new(REAL_CONFIG)
DHAN_SANDBOX = DhanHQ::Client.new(SANDBOX_CONFIG)
```

Then in your trading service:

```ruby
class TradingService
  def real_market_data
    DHAN_REAL.market_feed.subscribe(...)
  end

  def paper_trade(order_params)
    DHAN_SANDBOX.orders.create(order_params)
  rescue DhanHQ::SandboxNotSupportedError => e
    # log and fallback
  end
end
```

---

### Phase 7: Release Process

1. **Bump version** (e.g., `2.1.0`) – minor because backward compatible.
2. **Update CHANGELOG** – list new features (multi-client support) and deprecations.
3. **Publish to RubyGems**.
4. **Announce** on your GitHub repo, pointing users to the migration guide.

---

### Phase 8: Internal Adoption in Your Rails App

1. Update your Rails app’s `Gemfile` to point to the new gem version.
2. Change the initializer to create both clients (as above).
3. Gradually replace all calls to `DhanHQ::Order.create` with `DHAN_SANDBOX.orders.create` (for paper trading) or `DHAN_REAL.orders.create` (if you ever need real orders).
4. Ensure the paper trading logic uses the sandbox client and handles unsupported endpoint errors gracefully.

---

### Summary of Changes to the Gem

| File / Module | Change |
|---------------|--------|
| `lib/dhanhq/configuration.rb` | New class – holds config attributes. |
| `lib/dhanhq/client.rb` | New class – manages connection and resource instances. |
| `lib/dhanhq/resources/*.rb` | Refactor to accept a client and use it for requests. |
| `lib/dhanhq.rb` | Keep global `configure` and `configuration`; add `default_client`; add deprecation helper. |
| `lib/dhanhq/order.rb` (and other top-level classes) | Convert to proxy methods delegating to `default_client`. |
| `lib/dhanhq/sandbox_support.rb` | New module to track supported endpoints. |

---

### Potential Pitfalls & Mitigations

- **Thread-safety:** Global default client is shared; if you use threads, create a client per thread or use `RequestStore`. The instance-based approach is inherently thread-safe because each client is independent.
- **Faraday connection reuse:** The client’s `@connection` is reused; that’s fine as long as you don’t mutate headers per request.
- **Testing:** Ensure your test suite covers both global and instance modes; you may need to reset `default_client` between tests.

---

This plan gives you a clear, incremental path to upgrade the gem. Start with the core refactoring (Phase 1), then add deprecations (Phase 1.5), and finally test and release. Let me know if you need code snippets for any specific part!

## Detailed Upgrade Plan – Option C: Build a Wrapper Gem (`dhanhq-multi`)

This plan outlines how to build a **separate wrapper gem** that sits on top of your existing `dhanhq-client` gem. The wrapper manages two internal clients (real + sandbox) and provides a unified, intelligent interface for your trading system.

This approach **leaves your published gem untouched**, avoiding breaking changes for other users, while giving you maximum control over the dual-environment logic.

---

### Phase 0: Design Philosophy & Constraints

| Principle | Rationale |
| :--- | :--- |
| **Explicit over Magical** | Avoid overusing `method_missing`. Use clear, named methods for critical operations (trading vs. market data). |
| **Fail Fast in Sandbox** | If a sandbox API isn’t supported, raise a clear error immediately rather than letting it timeout. |
| **Real is the Source of Truth** | Market data and WebSocket **always** come from the real client. Sandbox is only for order simulation. |
| **Underlying Gem Agnostic** | The wrapper should work with any version of `dhanhq-client` (>= 2.0) and simply delegate. |

---

### Phase 1: Scaffold the New Gem

```bash
bundle gem dhanhq-multi --test=rspec --mi
cd dhanhq-multi
```

**Update `dhanhq-multi.gemspec`:**
```ruby
Gem::Specification.new do |spec|
  spec.name          = "dhanhq-multi"
  spec.version       = "0.1.0"
  spec.summary       = "Wrapper for dhanhq-client to support real + sandbox environments simultaneously."
  spec.authors       = ["Your Name"]

  spec.add_dependency "dhanhq-client", "~> 2.0"   # Your existing gem
  spec.add_dependency "faraday", "~> 2.0"         # Already in the client, but good to pin
end
```

---

### Phase 2: Core Architecture – Configuration

Create a configuration object that holds **both** environment settings.

**`lib/dhanhq_multi/config.rb`:**
```ruby
module DhanHQMulti
  class Config
    attr_reader :real, :sandbox

    def initialize(real_params:, sandbox_params:)
      @real = build_config(real_params)
      @sandbox = build_config(sandbox_params)
      validate!
    end

    private

    def build_config(params)
      # Accept either a DhanHQ::Configuration instance or a plain hash
      return params if params.is_a?(DhanHQ::Configuration)

      DhanHQ::Configuration.new do |c|
        c.client_id    = params[:client_id]
        c.access_token = params[:access_token]
        c.base_url     = params[:base_url] || "https://api.dhan.co/v2"
        c.sandbox_mode = params[:sandbox_mode] || false
      end
    end

    def validate!
      raise ArgumentError, "Real client_id missing" if @real.client_id.nil?
      raise ArgumentError, "Sandbox client_id missing" if @sandbox.client_id.nil?
      # Add more validations as needed
    end
  end
end
```

---

### Phase 3: The Main Wrapper Class

This is the heart of the gem. It initializes two clients and provides explicit routing.

**`lib/dhanhq_multi/client.rb`:**
```ruby
module DhanHQMulti
  class Client
    attr_reader :real, :sandbox, :config

    def initialize(config)
      @config = config.is_a?(DhanHQMulti::Config) ? config : DhanHQMulti::Config.new(config)
      @real   = DhanHQ::Client.new(@config.real)
      @sandbox = DhanHQ::Client.new(@config.sandbox)
    end

    # ----- Explicit accessors (most reliable) -----

    # Use this for all real-market operations (WebSocket, live data)
    def market
      @real
    end

    # Use this for all paper-trading operations (orders, positions, etc.)
    def paper
      @sandbox
    end

    # ----- Domain-specific convenience methods -----

    # Subscribe to market data – always uses REAL
    def subscribe_market_data(symbols)
      @real.market_feed.subscribe(symbols)
    end

    # Place a paper trade – always uses SANDBOX
    def paper_trade(order_params)
      @sandbox.orders.create(order_params)
    rescue => e
      # If the sandbox returns a "not supported" error, wrap it
      raise SandboxUnsupportedError, "Sandbox failed: #{e.message}" if sandbox_unsupported_error?(e)
      raise
    end

    # ----- WebSocket (explicitly real only) -----
    def websocket
      @real.websocket
    end

    private

    def sandbox_unsupported_error?(error)
      error.message.include?("404") ||
      error.message.include?("not found") ||
      error.message.include?("unsupported")
    end
  end
end
```

**Note:** We provide *both* the low-level accessors (`market`, `paper`) and high-level convenience methods (`subscribe_market_data`, `paper_trade`). This gives your Rails app flexibility.

---

### Phase 4: Handling Sandbox Limitations (The "Support Matrix")

Create a module that explicitly maps which endpoints are **not** available in sandbox.

**`lib/dhanhq_multi/sandbox_support.rb`:**
```ruby
module DhanHQMulti
  module SandboxSupport
    UNSUPPORTED_RESOURCES = [
      :websocket,
      # List specific order types or endpoints here based on Dhan docs
      # e.g., :options_trading, :historical_data, etc.
    ].freeze

    UNSUPPORTED_METHODS = {
      market_feed: [:historical, :intraday],
      orders: [:modify]  # example
    }.freeze

    def self.supported?(resource, method = nil)
      return false if UNSUPPORTED_RESOURCES.include?(resource)
      return true if method.nil?
      !UNSUPPORTED_METHODS[resource]&.include?(method)
    end
  end
end
```

**Inject checks into the wrapper:**
```ruby
def paper_trade(order_params)
  # Check before calling the underlying gem
  unless SandboxSupport.supported?(:orders, :create)
    raise SandboxUnsupportedError, "Order creation is not supported in sandbox"
  end
  @sandbox.orders.create(order_params)
end
```

---

### Phase 5: Smart (Optional) Delegation with `method_missing`

If you want to keep the "auto-routing" from your initial snippet, implement it carefully with a **fallback to real** for unknown methods (which is safer for market data).

**Add to `DhanHQMulti::Client`:**
```ruby
# List of methods that are clearly trading (sandbox) vs market (real)
TRADING_METHODS = %i[orders positions holdings].freeze
MARKET_METHODS  = %i[market_feed ticker websocket].freeze

def method_missing(method_name, *args, &block)
  # If the method looks like a trading resource, use sandbox
  if TRADING_METHODS.include?(method_name)
    @sandbox.public_send(method_name, *args, &block)
  # If it looks like a market resource, use real
  elsif MARKET_METHODS.include?(method_name)
    @real.public_send(method_name, *args, &block)
  else
    # If unsure, default to REAL (safer for data) OR raise
    @real.public_send(method_name, *args, &block)
  end
rescue NoMethodError
  super
end

def respond_to_missing?(method_name, include_private = false)
  TRADING_METHODS.include?(method_name) ||
  MARKET_METHODS.include?(method_name) ||
  @real.respond_to?(method_name) ||
  super
end
```

**Caveat:** I recommend the explicit `market` / `paper` pattern over `method_missing` for a production trading system — it’s more readable and easier to debug.

---

### Phase 6: Error Handling & Custom Exceptions

Define custom exceptions for clear debugging.

**`lib/dhanhq_multi/errors.rb`:**
```ruby
module DhanHQMulti
  class Error < StandardError; end
  class ConfigError < Error; end
  class SandboxUnsupportedError < Error; end
  class SandboxFallbackError < Error; end   # For when auto-fallback fails
end
```

**Graceful fallback example** (if you ever want to auto-switch to real when sandbox fails):
```ruby
def paper_trade_with_fallback(order_params)
  @sandbox.orders.create(order_params)
rescue SandboxUnsupportedError
  Rails.logger.warn "Sandbox unsupported – falling back to real (paper trade disabled!)."
  # Option 1: raise to stop execution
  raise
  # Option 2: return a mock response
  { status: "simulated", message: "Sandbox not supported" }
end
```

---

### Phase 7: Rails Integration Guide

**1. Store credentials securely** (`config/credentials.yml.enc`):
```yaml
dhan:
  real:
    client_id: REAL_CLIENT_ID
    access_token: REAL_ACCESS_TOKEN
    base_url: https://api.dhan.co/v2
  sandbox:
    client_id: SANDBOX_CLIENT_ID
    access_token: SANDBOX_ACCESS_TOKEN
    base_url: https://sandbox.dhan.co/v2
```

**2. Create an initializer** (`config/initializers/dhan_multi.rb`):
```ruby
require "dhanhq_multi"

real_config = DhanHQ::Configuration.new do |c|
  c.client_id = Rails.application.credentials.dig(:dhan, :real, :client_id)
  c.access_token = Rails.application.credentials.dig(:dhan, :real, :access_token)
  c.base_url = Rails.application.credentials.dig(:dhan, :real, :base_url) || "https://api.dhan.co/v2"
end

sandbox_config = DhanHQ::Configuration.new do |c|
  c.client_id = Rails.application.credentials.dig(:dhan, :sandbox, :client_id)
  c.access_token = Rails.application.credentials.dig(:dhan, :sandbox, :access_token)
  c.base_url = Rails.application.credentials.dig(:dhan, :sandbox, :base_url) || "https://sandbox.dhan.co/v2"
end

$dhan = DhanHQMulti::Client.new(real: real_config, sandbox: sandbox_config)
```

**3. Use in your services:**
```ruby
class PaperTradingService
  def execute
    # Explicit is best:
    order = $dhan.paper.orders.create(symbol: "RELIANCE", qty: 10)

    # Or use the convenience method:
    order = $dhan.paper_trade(symbol: "RELIANCE", qty: 10)

    # Market data:
    feed = $dhan.market.market_feed.subscribe(["RELIANCE"])

    # WebSocket (only real):
    ws = $dhan.websocket.connect
  end
end
```

---

### Phase 8: Testing Strategy

| Test Level | What to Test |
| :--- | :--- |
| **Unit (Gem)** | `Config` validation, client initialization, `method_missing` routing (if used), error raising. |
| **Integration (Gem)** | Use WebMock to stub real/sandbox API endpoints. Ensure the wrapper sends requests to the correct base URL with correct credentials. |
| **Rails (App)** | Test that `$dhan.paper.orders.create` hits the sandbox URL and `$dhan.market.market_feed` hits the real URL in your actual app flow. |
| **Sandbox regression** | Periodically run a test suite against the actual sandbox to detect newly unsupported endpoints. |

---

### Phase 9: Release & Documentation

1. **Version** → `0.1.0` (initial release).
2. **Documentation in README:**
   - Installation (`gem 'dhanhq-multi'`).
   - Configuration examples (hash vs. `DhanHQ::Configuration`).
   - API reference (`#market`, `#paper`, `#paper_trade`, `#subscribe_market_data`).
   - Sandbox limitations table (link to Dhan docs).
   - Troubleshooting common sandbox errors.
3. **Changelog** – note that this is a wrapper, not a replacement for `dhanhq-client`.

---

### Phase 10: Maintenance & Evolution

- **Underlying Gem Updates:** When you update `dhanhq-client`, the wrapper inherits the fixes automatically.
- **New Sandbox Endpoints:** As DhanHQ adds more endpoints to sandbox, simply remove them from the `UNSUPPORTED_RESOURCES` list in the wrapper and release a patch version.
- **Extendability:** The wrapper can easily be extended to support a third environment (e.g., staging) by adding another config and client.

---

### Summary: Option C vs Option B

| Aspect | Option B (Extend Gem) | Option C (Wrapper Gem) |
| :--- | :--- | :--- |
| **Impact on published gem** | Breaking (major version) / requires refactor | None – `dhanhq-client` stays stable |
| **Complexity** | Moderate (core refactor) | Low (just delegation) |
| **Upgrading underlying gem** | Native support | Works automatically |
| **Ideal for** | General-purpose multi-environment gem | Your specific trading app only |
| **Maintenance** | One gem to maintain | Two gems to maintain (wrapper + core) |

**My Recommendation:** Since you already have a published `dhanhq-client` gem that other projects might depend on, **Option C** is safer, faster to implement, and isolates the dual-environment logic to your wrapper. You can always merge the wrapper logic into the main gem later as a 3.0 if needed.

Would you like me to elaborate on any specific part of the wrapper, such as implementing WebSocket proxying, handling authentication token refresh, or building a mock sandbox for local development?

This is a **very strategic approach** – keeping the main gem clean while offering an advanced wrapper for multi-environment setups.

Given that your current gem is **v3.4.0**, here is the exact phased roadmap to release **both** the refactored main gem (v4.0.0) and the new wrapper gem, ensuring a smooth transition for your existing users.

---

## The Recommended Release Strategy

### Core Rule: The Wrapper Depends on the Refactored v4.0.0
Your wrapper (`dhanhq-multi`) **must** depend on the refactored v4.0.0 of `dhanhq-client`.
*Why?* The wrapper needs `DhanHQ::Client.new(config)` to instantiate two isolated clients. If it depends on v3.4.0 (global state), it would have to use ugly hacks (like temporarily swapping global configs) which will break under concurrency (Puma threads, Sidekiq jobs).

---

## Phase 1: Release `dhanhq-client` v4.0.0 (The Refactor)

This is a **major version bump** (breaking change). You must give existing users a clear upgrade path.

### How to make v4.0.0 backward-compatible (to ease the pain):
Implement the instance-based architecture, but keep the global `DhanHQ.configure` as a **proxy** to a default client.

```ruby
# lib/dhanhq.rb (v4.0.0)

module DhanHQ
  class << self
    attr_writer :default_client

    def configure(&block)
      @configuration ||= Configuration.new
      yield(@configuration) if block_given?
      @default_client = Client.new(@configuration) # Auto-create default client
    end

    def default_client
      @default_client ||= Client.new(configuration)
    end

    # Global proxy methods (deprecated, but keep them working)
    def orders
      DhanHQ.deprecate("DhanHQ.orders is deprecated, use DhanHQ::Client.new.orders")
      default_client.orders
    end
  end
end
```

**What this achieves:**
- **Existing users** who just do `DhanHQ.configure { ... }` and call `DhanHQ::Order.create` will see deprecation warnings but **their code will not break**.
- **Advanced users** (like you) can use `DhanHQ::Client.new(config)`.
- **Release notes**: Clearly state that v4.0.0 introduces multi-instance support and deprecates global singletons.

### Migration Guide for v4.0.0:
```ruby
# OLD (v3.x)
DhanHQ.configure do |c|
  c.client_id = "123"
end
order = DhanHQ::Order.create(...)

# NEW (v4.x - Recommended)
client = DhanHQ::Client.new(DhanHQ::Configuration.new { |c| c.client_id = "123" })
order = client.orders.create(...)
```

---

## Phase 2: Release `dhanhq-multi` v1.0.0 (The Wrapper)

Now that v4.0.0 is out, release the wrapper.

### Dependency Lock in `dhanhq-multi.gemspec`:
```ruby
spec.add_dependency "dhanhq-client", ">= 4.0.0", "< 5.0.0"
```

### Why set it to `>= 4.0.0`?
- Ensures the wrapper is always used with the refactored version.
- If you release a v4.1.0 or v4.2.0 with bug fixes, the wrapper automatically inherits them without needing a new wrapper release.

### Full Wrapper Code Structure (v1.0.0):
Since you are building this specifically for your paper trading system, keep it lean and opinionated.

```ruby
# lib/dhanhq_multi/client.rb
module DhanHQMulti
  class Client
    attr_reader :real, :sandbox

    def initialize(real_config:, sandbox_config:)
      @real = DhanHQ::Client.new(real_config)
      @sandbox = DhanHQ::Client.new(sandbox_config)
    end

    # Market & WebSocket -> ALWAYS REAL
    def market
      @real
    end

    def websocket
      @real.websocket
    end

    # Paper Trading -> ALWAYS SANDBOX
    def paper
      @sandbox
    end

    # Convenience method with built-in sandbox error handling
    def place_paper_order(params)
      @sandbox.orders.create(params)
    rescue DhanHQ::Error => e
      raise DhanHQMulti::SandboxError, "Sandbox order failed: #{e.message}"
    end
  end
end
```

---

## Phase 3: Upgrade Your Rails App (The Final Step)

With both gems released, update your `Gemfile`:

```ruby
gem "dhanhq-client", "~> 4.0.0"   # The core
gem "dhanhq-multi", "~> 1.0.0"    # The wrapper
```

**Important:** You now have **two** ways to use DhanHQ in your app:

1. **Use the wrapper** (Recommended for your paper trading system):
   ```ruby
   real_conf = DhanHQ::Configuration.new { |c| c.client_id = ENV["REAL_ID"] }
   sandbox_conf = DhanHQ::Configuration.new { |c| c.client_id = ENV["SANDBOX_ID"] }
   $dhan = DhanHQMulti::Client.new(real_config: real_conf, sandbox_config: sandbox_conf)

   # For paper trading
   $dhan.paper.orders.create(...)
   # For market data
   $dhan.market.market_feed.subscribe(...)
   ```

2. **Use the core gem directly** (if you ever need just a single environment):
   ```ruby
   client = DhanHQ::Client.new(some_config)
   client.orders.create(...)
   ```

---

## Summary of the Version Matrix

| Component | Current Version | Next Version | Change Type | Dependency |
| :--- | :--- | :--- | :--- | :--- |
| **dhanhq-client** | 3.4.0 | **4.0.0** | Major (Instance-based clients, deprecations added) | None |
| **dhanhq-multi** | Not released | **1.0.0** | New Gem | `dhanhq-client` >= 4.0.0 |
| **Your Rails App** | Uses v3.4.0 | Uses v4.0.0 + v1.0.0 | App update | Both gems |

---

## Potential Pitfall to Avoid

**Do not** release `dhanhq-multi` v1.0.0 depending on `dhanhq-client` `~> 3.4.0`.
If you do that, you will have to release a **v2.0.0** of the wrapper later just to bump the dependency to v4.0.0. Save yourself the headache—launch the wrapper **exclusively** on top of the new v4.0.0 architecture.

---

## Timeline Recommendation

1. **Week 1-2**: Refactor `dhanhq-client` to v4.0.0-beta. Add deprecation warnings, test thoroughly.
2. **Week 3**: Release `dhanhq-client` v4.0.0 (stable). Announce the new multi-instance feature.
3. **Week 4**: Build and release `dhanhq-multi` v1.0.0 (depending on v4.0.0).
4. **Week 5**: Update your Rails app to use `dhanhq-multi` for the paper trading system.

This approach gives you **zero downtime**, a clean architectural separation, and does not force your existing gem users into the wrapper unless they explicitly choose to upgrade to v4.0.0.

Would you like me to draft the exact deprecation warnings or the RSpec test suite to ensure the v4.0.0 refactor doesn't break existing v3.x behavior?

**Build the `dhanhq-client` refactor first.**

Here is the hard dependency chain:
`dhanhq-multi` **requires** `dhanhq-client` v4.0.0 to exist (specifically, it needs `DhanHQ::Client.new(config)`). You cannot build, test, or release the wrapper until the core gem’s new API is finalized.

However, **"build first"** doesn't mean "release first." Here is the exact sequential workflow for development vs. release:

---

### Step 1: Build the Core (dhanhq-client v4.0.0) – Locally First
Start by refactoring `dhanhq-client` locally.

- Create the `Configuration` and `Client` classes.
- Ensure `Client.new(config)` works perfectly.
- *Crucial:* Do **not** release it to RubyGems yet. Just have the code ready on your machine (or in a feature branch).

### Step 2: Build the Wrapper (dhanhq-multi) – Against the Local Core
Now, create the `dhanhq-multi` gem in a separate folder.

In the wrapper's `Gemfile` or `.gemspec`, point to your **local** copy of the main gem for development:

```ruby
# In dhanhq-multi's Gemfile (development)
gem "dhanhq-client", path: "../dhanhq-client"
```

This allows you to write the wrapper's code (`@real = DhanHQ::Client.new(config)`) and run integration tests **immediately**, without waiting for the release. If you find that the wrapper needs a specific method in the core client (e.g., `client.websocket`), you can go back to Step 1, add it, and refine the API in real-time.

### Step 3: Stabilize Both in Parallel
Once both gems work perfectly together in your local Rails app, freeze the API.

- Commit the v4.0.0 changes in `dhanhq-client`.
- Commit the v1.0.0 changes in `dhanhq-multi`.

### Step 4: Release Order (Crucial)
When publishing to RubyGems, the order is **strict**:

1. **Release `dhanhq-client` v4.0.0** to RubyGems.org.
2. **Update the wrapper's `.gemspec`** to remove the `path` dependency and set:
   ```ruby
   spec.add_dependency "dhanhq-client", ">= 4.0.0", "< 5.0.0"
   ```
3. **Release `dhanhq-multi` v1.0.0** to RubyGems.org.

---

### Why you absolutely cannot release the wrapper first:
- **Broken Dependencies:** If you release `dhanhq-multi` v1.0.0 with a dependency on `dhanhq-client >= 4.0.0`, and v4.0.0 isn't on RubyGems yet, `bundle install` will fail for anyone trying to use your wrapper.
- **Runtime Errors:** Even if you try to release the wrapper depending on `~> 3.4.0` (to bypass the missing version), your wrapper code calls `DhanHQ::Client.new`, which doesn't exist in v3.4.0 – so it will crash instantly.

---

### A Pro-Tip for this Transition
You don't have to wait for the wrapper to be 100% complete before releasing the core.

- Release `dhanhq-client` v4.0.0 as soon as the instance-based client is stable.
- Let your existing users adopt v4.0.0 if they like (they just get deprecation warnings).
- **Then**, take your time building and releasing `dhanhq-multi` v1.0.0.

This decouples the release schedules. Your paper trading system can temporarily use the core v4.0.0 directly (manually creating two `Client` instances in an initializer) while you polish the wrapper gem in the background.

Based on Dhan's official documentation and community discussions, here is a clear breakdown of what the Sandbox environment supports (and, crucially, **does not** support).

### 🟢 Supported Features (Works in Sandbox)

The Sandbox is designed to be a near-exact replica of the Live API for testing purposes.

*   **Trading APIs**: You can test the full order lifecycle—placing, modifying, canceling, and viewing orders. This includes various order types (e.g., Limit, Market, GTT, Cover Order).
*   **Portfolio & Funds**: You can manage and view virtual positions, holdings, and fund limits.
*   **Data APIs**: You can test data endpoints, including fetching **historical data** and charts.
*   **EDIS (Electronic Dispute Resolution)**: You can test the EDIS workflow for corporate actions.

### 🔴 Key Limitations (Does NOT Work in Sandbox)

These are the most critical differences to account for in your architecture.

*   **❌ WebSocket / Real-Time Streaming**: **Not available.** You cannot get live streaming market data or real-time order updates via WebSocket in the Sandbox.
*   **❌ Not All Endpoints are Present**: While it supports many APIs, not every single endpoint is available. For example, the **Option Chain API** is notably absent from the Sandbox.
*   **❌ Mock Order Execution**: Orders are **simulated**, not actually routed to the exchange.
    *   All orders get filled at a static price of **₹100**.
    *   You cannot use this to benchmark real-world performance like latency or slippage.
*   **❌ Real Market Data**: You cannot fetch live market data (like LTP) without a separate Data API subscription, even in Sandbox.

### 💡 Key Sandbox Behavior to Know

*   **Virtual Capital**: Starts fresh every day with ₹10,00,000 in virtual funds.
*   **No Static IP Required**: You don't need to whitelist a static IP for Sandbox testing.

### 📝 Summary for Your Architecture

Since WebSocket and real-time data are unavailable in the Sandbox, your plan to **use the Real environment for market data/WebSocket and the Sandbox for paper trading** is exactly the right approach.

When building your `dhanhq-multi` gem, you should implement checks for Sandbox limitations. For example, if a user tries to use WebSocket with the Sandbox client, you can raise a clear `SandboxUnsupportedError`. This keeps your wrapper robust and user-friendly.

Here is the **complete architectural blueprint** for your Rails trading system, designed to seamlessly route traffic between the **Real** (market data/WebSocket) and **Sandbox** (paper trading) environments using your planned `dhanhq-client` (v4) + `dhanhq-multi` (v1) stack.

---

### 1. High-Level System Architecture (Layered View)

We structure the system into four distinct layers to maintain clean separation of concerns:

| Layer | Component | Responsibility |
| :--- | :--- | :--- |
| **1. Presentation** | Rails Controllers / GraphQL | Accepts user requests (e.g., "place trade", "view chart"). |
| **2. Application Services** | `TradingService`, `MarketDataService`, `PortfolioService` | Orchestrates business logic; **decides** which client to call. |
| **3. Infrastructure (Wrapper)** | `DhanHQMulti::Client` | Holds both `@real` and `@sandbox` clients. Provides explicit accessors (`.market`, `.paper`). |
| **4. Core Gem** | `dhanhq-client` (v4.0.0) | Handles raw HTTP requests, authentication, WebSocket connections, and response parsing. |

---

### 2. Configuration Layer (Rails Initializer)

Load credentials securely and initialize the wrapper once.

```ruby
# config/initializers/dhan_multi.rb

REAL_CONFIG = DhanHQ::Configuration.new do |c|
  c.client_id    = Rails.application.credentials.dhan[:real][:client_id]
  c.access_token = Rails.application.credentials.dhan[:real][:access_token]
  c.base_url     = "https://api.dhan.co/v2"
  c.sandbox_mode = false
end

SANDBOX_CONFIG = DhanHQ::Configuration.new do |c|
  c.client_id    = Rails.application.credentials.dhan[:sandbox][:client_id]
  c.access_token = Rails.application.credentials.dhan[:sandbox][:access_token]
  c.base_url     = "https://sandbox.dhan.co/v2"
  c.sandbox_mode = true
end

# Global instance accessible throughout the app
DHAN_CLIENT = DhanHQMulti::Client.new(
  real_config: REAL_CONFIG,
  sandbox_config: SANDBOX_CONFIG
)
```

---

### 3. The Decision Matrix (Which Client to Use?)

This is the **core routing logic** for your application. Strictly enforce these rules in your service objects.

| Business Function | API Endpoints | Client to Use | Rationale |
| :--- | :--- | :--- | :--- |
| **Live Market Data** | `market_feed`, `ticker`, `historical` | **Real** (`DHAN_CLIENT.real`) | Sandbox returns mock/static prices; not real-time. |
| **WebSocket Streaming** | `websocket.connect` | **Real** (`DHAN_CLIENT.real`) | Sandbox explicitly **does not** support WebSockets. |
| **Paper Trading (Orders)** | `orders.create`, `orders.cancel`, `orders.modify` | **Sandbox** (`DHAN_CLIENT.paper`) | Prevents accidental real-money execution. |
| **Paper Portfolio** | `positions`, `holdings`, `funds` | **Sandbox** (`DHAN_CLIENT.paper`) | Virtual capital lives here. |
| **Option Chain / EDIS** | Option chain, EDIS workflows | **Sandbox** (if supported) / **Real** (if not) | Check the sandbox support matrix; fallback to real with a warning if unsupported. |

---

### 4. Application Service Layer (The "Traffic Cop")

Create explicit service classes that encapsulate the routing logic. **Never** let controllers call `DHAN_CLIENT.real` or `.paper` directly—always go through services.

```ruby
# app/services/market_data_service.rb
class MarketDataService
  def self.subscribe(symbols)
    # ALWAYS uses Real for live data
    DHAN_CLIENT.real.market_feed.subscribe(symbols)
  end

  def self.historical(symbol, from, to)
    DHAN_CLIENT.real.market_feed.historical(symbol, from, to)
  end
end

# app/services/paper_trading_service.rb
class PaperTradingService
  def self.place_order(params)
    # ALWAYS uses Sandbox for placing trades
    DHAN_CLIENT.paper.orders.create(params)
  rescue DhanHQMulti::SandboxUnsupportedError => e
    # Log the issue, notify admin, and fail gracefully
    Rails.logger.error "Sandbox limitation: #{e.message}"
    { status: "error", message: "Sandbox does not support this order type" }
  end

  def self.view_positions
    DHAN_CLIENT.paper.positions.all
  end
end

# app/services/websocket_service.rb
class WebsocketService
  def self.connect
    # WebSocket only works on Real
    DHAN_CLIENT.real.websocket.connect
  end
end
```

---

### 5. Data Modeling (Separating Paper vs. Real Locally)

Since you are paper trading, you must store a flag in your local database to distinguish between **simulated** and **real** trades—even though your backend always sends paper orders to the Sandbox, you might later add live trading.

```ruby
# db/migrate/create_trades.rb
class CreateTrades < ActiveRecord::Migration[7.0]
  def change
    create_table :trades do |t|
      t.string :dhan_order_id
      t.string :symbol
      t.integer :quantity
      t.decimal :price
      t.string :side # BUY/SELL
      t.boolean :paper_trade, default: true # TRUE = Sandbox, FALSE = Real
      t.jsonb :raw_response
      t.timestamps
    end
  end
end
```

**Service logic to save:**
```ruby
def self.place_order(params)
  response = DHAN_CLIENT.paper.orders.create(params)
  Trade.create!(
    dhan_order_id: response["order_id"],
    paper_trade: true, # Explicitly mark as paper
    raw_response: response
  )
  response
end
```

---

### 6. Handling WebSocket in a Dual-Client World

Since WebSocket only works on `real`, but you might want to push updates to your frontend:

```ruby
# app/services/market_stream_service.rb
class MarketStreamService
  def self.start_stream
    # Use the REAL client for WebSocket connection
    ws = DHAN_CLIENT.real.websocket.connect

    ws.on(:message) do |data|
      # Broadcast to your Rails Action Cable channel
      ActionCable.server.broadcast("market_channel", data)
    end

    ws
  end
end
```

---

### 7. Concurrency & Thread Safety (Crucial for Puma/Sidekiq)

Because `DHAN_CLIENT` is a global singleton holding two separate Faraday connections, **it is thread-safe**, provided your wrapper does not mutate shared state.

**Do this** (Safe):
```ruby
# Each request uses the same global client, but calls separate methods.
def place_order
  DHAN_CLIENT.paper.orders.create(...) # No shared mutation
end
```

**Avoid this** (Unsafe):
```ruby
# Never dynamically change the base_url or access_token on the global instance.
DHAN_CLIENT.real.config.base_url = "something_else" # BAD
```

If you use **Sidekiq** (background jobs), ensure your jobs do not hold onto WebSocket connections. Always close WebSockets after use, or use separate connection pools.

---

### 8. Background Job Strategy (Async Paper Trades)

If you want to place paper trades asynchronously:

```ruby
# app/jobs/paper_trade_job.rb
class PaperTradeJob < ApplicationJob
  queue_as :default

  def perform(order_params)
    # The job uses the same global DHAN_CLIENT
    # No need to pass credentials—they are globally configured.
    PaperTradingService.place_order(order_params)
  rescue => e
    # Retry logic or dead-letter queue
    Rails.logger.error "Paper trade failed: #{e.message}"
  end
end
```

---

### 9. Error Handling & Fallback Strategy

Implement a robust error-handling matrix:

| Scenario | Action |
| :--- | :--- |
| **Sandbox returns 404 (unsupported endpoint)** | Rescue and log. Return a user-friendly error: "This feature is currently unavailable in paper trading." |
| **Sandbox rate-limited** | Implement exponential backoff and retry. |
| **Real environment fails (market data)** | Return cached data if available. If not, alert the admin and fail gracefully. |
| **WebSocket disconnects** | Auto-reconnect with a backoff timer (using `reconnect_after`). |

```ruby
# In your wrapper gem
def paper_trade(params)
  @sandbox.orders.create(params)
rescue Faraday::ResourceNotFound => e
  raise SandboxUnsupportedError, "This API endpoint is not supported in Sandbox."
end
```

---

### 10. Complete End-to-End Flow (User Places a Paper Trade)

1.  **User clicks "Buy"** on the frontend (React/ERB).
2.  **Rails Controller** receives the request and calls `PaperTradingService.place_order(params)`.
3.  **`PaperTradingService`** calls `DHAN_CLIENT.paper.orders.create(params)`.
4.  **`DhanHQMulti`** routes the request to the internal `@sandbox` client (which points to `https://sandbox.dhan.co/v2`).
5.  **`dhanhq-client` (v4)** builds the Faraday request, injects the Sandbox `client_id`/`access_token`, and sends the HTTP POST.
6.  **Sandbox API** simulates the order (fills at ₹100) and returns a mock `order_id`.
7.  **Service** saves the order to your local `trades` table with `paper_trade: true`.
8.  **Controller** returns a success JSON response to the user.

---

### Summary Diagram (Mental Model)

```text
[ Rails App ]
      |
      v
[ Service Layer ]  <--- Decides: "Paper or Real?"
      |
      +------ (Paper) ------> DHAN_CLIENT.paper.orders.create
      |                            |
      |                            v
      |                    [ Sandbox API ]
      |
      +------ (Real) -------> DHAN_CLIENT.real.market_feed.subscribe
                                   |
                                   v
                            [ Real API / WebSocket ]
```

---

### Final Recommendation for Your Architecture

1.  **Never** hardcode `base_url` or credentials in your services—always rely on the wrapper.
2.  **Always** mark local DB records with `paper_trade: boolean` to maintain audit trails.
3.  **Abstract** external API calls behind service objects (`MarketDataService`, `PaperTradingService`) so that if you later add a third environment (e.g., UAT), you only change the service, not the controllers.
4.  **Write integration tests** that stub the real/sandbox clients separately to ensure routing logic never mixes them up.

This architecture gives you the agility to test trading strategies risk-free (Sandbox) while consuming live market data (Real) and easily pivot to live trading later by simply toggling the `paper_trade` flag in your service classes.