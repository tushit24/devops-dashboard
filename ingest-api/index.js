const express = require('express');
const cors = require('cors');
const { createClient } = require('redis');
const { Pool } = require('pg');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb');


const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS
app.use(cors({
  origin: process.env.DASHBOARD_URL || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

// Body parser
app.use(express.json());

// Redis Connection Setup
const redisHost = process.env.REDIS_HOST || 'localhost';
const redisPort = process.env.REDIS_PORT || 6379;
const redisClient = createClient({
  url: `redis://${redisHost}:${redisPort}`
});

redisClient.on('error', (err) => console.error('Redis Client Error', err));
redisClient.on('connect', () => console.log('Connected to Redis'));

// Postgres Connection Setup
const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'postgres_password',
  database: process.env.POSTGRES_DB || 'devops_dashboard',
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client', err);
});

// Conditional DynamoDB Setup
const useDynamoDB = process.env.USE_DYNAMODB === 'true';
let ddbDocClient = null;

if (useDynamoDB) {
  const ddbConfig = {};
  if (process.env.AWS_REGION) {
    ddbConfig.region = process.env.AWS_REGION;
  }
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    ddbConfig.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    };
  }
  const ddbClient = new DynamoDBClient(ddbConfig);
  ddbDocClient = DynamoDBDocumentClient.from(ddbClient);
  console.log('DynamoDB integration enabled for Ingest API.');
} else {
  console.log('PostgreSQL integration enabled for Ingest API.');
}


// Middleware to ensure Redis is connected
let redisConnected = false;
async function connectRedis() {
  try {
    if (!redisConnected) {
      await redisClient.connect();
      redisConnected = true;
    }
  } catch (error) {
    console.error('Error connecting to Redis, retrying...', error);
    setTimeout(connectRedis, 5000);
  }
}
connectRedis();

// Health Check
app.get('/health', async (req, res) => {
  try {
    // Check PG Connection
    const pgClient = await pool.connect();
    pgClient.release();
    
    // Check Redis Connection
    const redisPing = redisConnected ? await redisClient.ping() : 'disconnected';
    
    res.json({
      status: 'healthy',
      postgres: 'connected',
      redis: redisPing === 'PONG' ? 'connected' : 'disconnected'
    });
  } catch (err) {
    res.status(500).json({
      status: 'unhealthy',
      error: err.message
    });
  }
});

// Ingest Event Endpoint
app.post('/events', async (req, res) => {
  const { type, message } = req.body;

  if (!type || !message) {
    return res.status(400).json({ error: 'Missing required fields: type and message' });
  }

  const validTypes = ['info', 'warning', 'error'];
  if (!validTypes.includes(type.toLowerCase())) {
    return res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
  }

  const event = {
    type: type.toLowerCase(),
    message,
    timestamp: new Date().toISOString()
  };

  try {
    if (!redisConnected) {
      throw new Error('Redis connection is not established yet');
    }
    // Push event to queue
    await redisClient.rPush('events_queue', JSON.stringify(event));
    res.status(202).json({ status: 'queued', event });
  } catch (err) {
    console.error('Failed to enqueue event', err);
    res.status(500).json({ error: 'Failed to queue event', details: err.message });
  }
});

// Fetch Stats Endpoint
app.get('/stats', async (req, res) => {
  if (useDynamoDB) {
    try {
      const tableName = 'dashboard-stats';
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const eventTypes = ['info', 'warning', 'error'];
      
      // Query aggregates per type from DynamoDB
      const queryPromises = eventTypes.map(async (type) => {
        const command = new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'event_type = :type AND #minute >= :since',
          ExpressionAttributeNames: {
            '#minute': 'minute'
          },
          ExpressionAttributeValues: {
            ':type': type,
            ':since': thirtyMinutesAgo
          }
        });
        const response = await ddbDocClient.send(command);
        return response.Items || [];
      });

      const results = await Promise.all(queryPromises);
      const allItems = results.flat();
      
      // Sort: minute DESC, event_type ASC
      allItems.sort((a, b) => {
        if (a.minute !== b.minute) {
          return b.minute.localeCompare(a.minute);
        }
        return a.event_type.localeCompare(b.event_type);
      });

      return res.json(allItems);
    } catch (err) {
      if (err.name === 'ResourceNotFoundException') {
        console.log('DynamoDB dashboard-stats table does not exist yet. Returning empty list.');
        return res.json([]);
      }
      console.error('Failed to fetch stats from DynamoDB', err);
      return res.status(500).json({ error: 'Failed to fetch statistics from DynamoDB', details: err.message });
    }
  }

  try {
    // Query aggregated logs per event type per minute for the last 30 minutes
    // Handled gracefully in case the table doesn't exist yet
    const query = `
      SELECT event_type, minute, count
      FROM event_aggregates
      WHERE minute >= NOW() - INTERVAL '30 minutes'
      ORDER BY minute DESC, event_type ASC
      LIMIT 100;
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    // If the table doesn't exist yet, return an empty array rather than failing
    if (err.code === '42P01') { // undefined_table code in postgres
      console.log('Postgres event_aggregates table does not exist yet. Returning empty list.');
      return res.json([]);
    }
    console.error('Failed to fetch stats from database', err);
    res.status(500).json({ error: 'Failed to fetch statistics', details: err.message });
  }
});

// Graceful Shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received. Closing servers...');
  if (redisConnected) {
    await redisClient.disconnect();
  }
  await pool.end();
  process.exit(0);
});

// Start Server
app.listen(PORT, () => {
  console.log(`Ingest API listening on port ${PORT}`);
});
