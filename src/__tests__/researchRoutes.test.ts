import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { researchRoutes } from '../routes/research';
import type { ResearchOrchestrator } from '../services/research/researchOrchestrator';

describe('Research Routes HTTP API', () => {
  let app: express.Express;
  let server: Server;
  let baseUrl: string;
  let mockOrchestrator: Partial<ResearchOrchestrator>;

  beforeAll((done) => {
    mockOrchestrator = {
      analyze: jest.fn().mockResolvedValue({
        runId: 'res_test123',
        symbol: 'RELIANCE',
        exchange: 'NSE',
        status: 'COMPLETED',
        startedAt: Date.now(),
        evidenceCount: 5,
        verdict: { stance: 'BUY', qualityScore: 85, valuationScore: 70, compositeScore: 79 },
      }),
      getRun: jest.fn().mockImplementation(async (id: string) => {
        if (id === 'res_test123') {
          return { runId: id, symbol: 'RELIANCE', status: 'COMPLETED', verdict: { stance: 'BUY' } } as any;
        }
        return null;
      }),
      listRuns: jest.fn().mockResolvedValue([
        { id: 'res_test123', symbol: 'RELIANCE', status: 'COMPLETED', verdict: 'BUY' },
      ]),
      getEvidence: jest.fn().mockResolvedValue([
        { id: 'EV-0001', claim: 'Revenue grew 18%', metric: 'revenue_growth', confidence: 0.95 },
      ]),
    };

    app = express();
    app.use(express.json());
    app.use('/api/research', researchRoutes(mockOrchestrator as unknown as ResearchOrchestrator));

    server = app.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      baseUrl = `http://127.0.0.1:${port}/api/research`;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  it('POST /analyze initiates research and returns completed run', async () => {
    const res = await fetch(`${baseUrl}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'RELIANCE' }),
    });

    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.symbol).toBe('RELIANCE');
    expect(data.runId).toBe('res_test123');
    expect(data.verdict?.stance).toBe('BUY');
  });

  it('POST /analyze returns 400 when symbol is missing', async () => {
    const res = await fetch(`${baseUrl}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const data: any = await res.json();
    expect(data.error).toContain('symbol is required');
  });

  it('GET /runs returns listed research runs', async () => {
    const res = await fetch(`${baseUrl}/runs?limit=10`);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.count).toBe(1);
    expect(data.runs[0].symbol).toBe('RELIANCE');
  });

  it('GET /:runId returns detailed run information', async () => {
    const res = await fetch(`${baseUrl}/res_test123`);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.runId).toBe('res_test123');
  });

  it('GET /:runId returns 404 for unknown run id', async () => {
    const res = await fetch(`${baseUrl}/res_unknown`);
    expect(res.status).toBe(404);
  });

  it('GET /:runId/evidence returns audit trail claims', async () => {
    const res = await fetch(`${baseUrl}/res_test123/evidence`);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.count).toBe(1);
    expect(data.evidence[0].id).toBe('EV-0001');
  });
});
