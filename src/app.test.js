const request = require('supertest');
const app = require('./index');

describe('Health Check API', () => {
  it('should return 200 and a healthy status message', async () => {
    const response = await request(app).get('/');
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('status', 'healthy');
    expect(response.body).toHaveProperty('message', '🚀 Training Ops API is running!');
  });
});
