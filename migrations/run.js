require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function run() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is missing. Add it to backend/.env first.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  const files = fs.readdirSync(__dirname)
    .filter(file => file.endsWith('.sql'))
    .sort();

  for (const fileName of files) {
    const file = path.join(__dirname, fileName);
    const sql = fs.readFileSync(file, 'utf8');
    console.log(`Running migration: ${fileName}`);
    await pool.query(sql);
  }

  await pool.end();
  console.log('Database migrations complete.');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
