require('dotenv').config({ path: '.env' });

const app = require('./app');

const PORT = process.env.PORT || 5000;

console.log('DATABASE_URL loaded:', process.env.DATABASE_URL ? 'YES' : 'NO');

app.listen(PORT, () => {
  console.log(`EarnyX API running on port ${PORT}`);
});