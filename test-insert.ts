import pg from 'pg'; 
const { Client } = pg; 
const client = new Client({ connectionString: 'postgresql://postgres.wsqvmnznwjchycekauxc:f3jlkd7Xhhx4iMc6@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres' }); 
client.connect()
  .then(() => client.query("INSERT INTO clarity_app.users (id, name, email, password_hash) VALUES ('f3e1a0b3-0b0c-4e8c-8f1a-0b0c4e8c8f1c', 'Test', 'test3@test.com', 'pwd')"))
  .then(() => console.log('OK'))
  .catch(e => console.error(e))
  .finally(() => client.end());
