import { isUsableDhanToken, resolveDhanClientId, hasTotpCredentials } from '../auth';

describe('isUsableDhanToken', () => {
  it('rejects empty, placeholder, and too-short tokens', () => {
    expect(isUsableDhanToken(null)).toBe(false);
    expect(isUsableDhanToken('')).toBe(false);
    expect(isUsableDhanToken('short')).toBe(false);
    expect(isUsableDhanToken('your_access_token')).toBe(false);
  });

  it('accepts realistic-length tokens', () => {
    expect(isUsableDhanToken('x'.repeat(50))).toBe(true);
  });
});

describe('resolveDhanClientId', () => {
  it('prefers .env client id over Redis', () => {
    expect(resolveDhanClientId('env-id', 'redis-id')).toBe('env-id');
    expect(resolveDhanClientId('', 'redis-id')).toBe('redis-id');
  });
});

describe('credential helpers', () => {
  const orig = { pin: process.env.DHAN_PIN, totp: process.env.DHAN_TOTP_SECRET, id: process.env.DHAN_CLIENT_ID };

  afterEach(() => {
    if (orig.pin === undefined) delete process.env.DHAN_PIN;
    else process.env.DHAN_PIN = orig.pin;
    if (orig.totp === undefined) delete process.env.DHAN_TOTP_SECRET;
    else process.env.DHAN_TOTP_SECRET = orig.totp;
    if (orig.id === undefined) delete process.env.DHAN_CLIENT_ID;
    else process.env.DHAN_CLIENT_ID = orig.id;
  });

  it('hasTotpCredentials requires pin, secret, and client id', () => {
    delete process.env.DHAN_PIN;
    delete process.env.DHAN_TOTP_SECRET;
    delete process.env.DHAN_CLIENT_ID;
    expect(hasTotpCredentials()).toBe(false);
    process.env.DHAN_PIN = '1';
    process.env.DHAN_TOTP_SECRET = 's';
    process.env.DHAN_CLIENT_ID = 'c';
    expect(hasTotpCredentials()).toBe(true);
  });
});
