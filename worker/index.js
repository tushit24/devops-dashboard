const { createClient } = require('redis');
const { Pool } = require('pg');
const { DynamoDBClient, CreateTableCommand, DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');


let running = true;

// Redis Connection Setup
const redisHost = process.env.REDIS_HOST || 'localhost';
const redisPort = process.env.REDIS_PORT || 6379;
const redisClient = createClient({
  url: `redis://${redisHost}:${redisPort}`,
  socket: {
    reconnectStrategy: (retries) => {
      console.log(`Redis reconnect attempt ${retries}`);
      return Math.min(retries * 500, 5000); // Wait up to 5s between retries
    }
  }
});

redisClient.on('error', (err) => console.error('Redis Client Error:', err));
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
  console.error('Unexpected Postgres pool error:', err);
});

// Conditional DynamoDB Setup
const useDynamoDB = process.env.USE_DYNAMODB === 'true';
let ddbDocClient = null;
let ddbClient = null;

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
  ddbClient = new DynamoDBClient(ddbConfig);
  ddbDocClient = DynamoDBDocumentClient.from(ddbClient);
  console.log('DynamoDB integration enabled for Worker.');
} else {
  console.log('PostgreSQL integration enabled for Worker.');
}


// Helper for delay
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Ensure Postgres database schema is set up
async function initializeDatabase() {
  const initQuery = `
    CREATE TABLE IF NOT EXISTS event_aggregates (
      event_type VARCHAR(50) NOT NULL,
      minute TIMESTAMP NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (event_type, minute)
    );
  `;
  let success = false;
  while (!success && running) {
    try {
      console.log('Initializing PostgreSQL database schema...');
      await pool.query(initQuery);
      console.log('PostgreSQL database schema initialized successfully.');
      success = true;
    } catch (err) {
      console.error('Failed to initialize database, retrying in 5 seconds...', err.message);
      await delay(5000);
    }
  }
}

// Ensure DynamoDB Table is set up and active
async function initializeDynamoDB() {
  const tableName = 'dashboard-stats';
  let success = false;
  while (!success && running) {
    try {
      console.log(`Checking if DynamoDB table '${tableName}' exists...`);
      const describeCommand = new DescribeTableCommand({ TableName: tableName });
      const response = await ddbClient.send(describeCommand);
      console.log(`DynamoDB table '${tableName}' exists and status is '${response.Table.TableStatus}'.`);
      
      if (response.Table.TableStatus !== 'ACTIVE') {
        console.log('Waiting for table to become ACTIVE...');
        await delay(5000);
        continue;
      }
      success = true;
    } catch (err) {
      if (err.name === 'ResourceNotFoundException') {
        console.log(`DynamoDB table '${tableName}' not found. Creating table with PAY_PER_REQUEST billing...`);
        try {
          const createCommand = new CreateTableCommand({
            TableName: tableName,
            AttributeDefinitions: [
              { AttributeName: 'event_type', AttributeType: 'S' },
              { AttributeName: 'minute', AttributeType: 'S' }
            ],
            KeySchema: [
              { AttributeName: 'event_type', KeyType: 'HASH' },
              { AttributeName: 'minute', KeyType: 'RANGE' }
            ],
            BillingMode: 'PAY_PER_REQUEST'
          });
          await ddbClient.send(createCommand);
          console.log(`DynamoDB table creation triggered. Waiting for table to become active...`);
          await delay(5000);
        } catch (createErr) {
          console.error('Failed to trigger DynamoDB table creation, retrying in 5 seconds...', createErr.message);
          await delay(5000);
        }
      } else {
        console.error('Error connecting to DynamoDB, retrying in 5 seconds...', err.message);
        await delay(5000);
      }
    }
  }
}


// Main worker consumer loop
async function startWorker() {
  // Ensure DB table exists first
  if (useDynamoDB) {
    await initializeDynamoDB();
  } else {
    await initializeDatabase();
  }

  // Connect to Redis
  try {
    await redisClient.connect();
  } catch (err) {
    console.error('Initial Redis connection failed, redis client will auto-retry...', err.message);
  }

  console.log('Worker is listening for events on queue: events_queue');

  while (running) {
    try {
      if (!redisClient.isOpen) {
        // Wait briefly if redis connection is currently down
        await delay(1000);
        continue;
      }

      // Blpop returns { key: 'events_queue', element: '...' }
      // The second argument is timeout in seconds. 0 blocks indefinitely.
      // We block for up to 10 seconds per loop iteration to allow checking the 'running' flag periodically.
      const result = await redisClient.blPop('events_queue', 10);
      
      if (!result) {
        // Timeout reached with no new events, loop again
        continue;
      }

      const { element } = result;
      console.log(`Received queue message: ${element}`);

      let event;
      try {
        event = JSON.parse(element);
      } catch (parseErr) {
        console.error('Failed to parse event JSON, skipping event. Raw:', element, parseErr);
        continue;
      }

      const { type, timestamp } = event;
      if (!type) {
        console.warn('Event missing type, skipping:', event);
        continue;
      }

      // Aggregate counts by type per minute
      // Truncate timestamp to start of the minute
      const eventTime = timestamp ? new Date(timestamp) : new Date();
      if (isNaN(eventTime.getTime())) {
        console.warn('Invalid timestamp in event, skipping:', event);
        continue;
      }
      
      eventTime.setSeconds(0);
      eventTime.setMilliseconds(0);
      const minuteBucket = eventTime.toISOString();

      if (useDynamoDB) {
        // Upsert into DynamoDB
        const updateCommand = new UpdateCommand({
          TableName: 'dashboard-stats',
          Key: {
            event_type: type.toLowerCase(),
            minute: minuteBucket
          },
          UpdateExpression: 'SET #count = if_not_exists(#count, :zero) + :val',
          ExpressionAttributeNames: {
            '#count': 'count'
          },
          ExpressionAttributeValues: {
            ':zero': 0,
            ':val': 1
          }
        });
        await ddbDocClient.send(updateCommand);
        console.log(`Successfully aggregated and updated DynamoDB: type=${type.toLowerCase()} minute=${minuteBucket}`);
      } else {
        // Upsert into Postgres
        const upsertQuery = `
          INSERT INTO event_aggregates (event_type, minute, count)
          VALUES ($1, $2, 1)
          ON CONFLICT (event_type, minute)
          DO UPDATE SET count = event_aggregates.count + 1;
        `;

        await pool.query(upsertQuery, [type.toLowerCase(), minuteBucket]);
        console.log(`Successfully aggregated and upserted: type=${type.toLowerCase()} minute=${minuteBucket}`);
      }

    } catch (err) {
      console.error('Error in worker processing loop:', err);
      // Wait a bit to prevent tight loop on persistent failures
      await delay(2000);
    }
  }
}

// Graceful shutdown handling
const shutdown = async () => {
  console.log('Shutting down worker gracefully...');
  running = false;
  
  try {
    if (redisClient.isOpen) {
      await redisClient.disconnect();
    }
    await pool.end();
    console.log('Connections closed. Exiting.');
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start
startWorker();
