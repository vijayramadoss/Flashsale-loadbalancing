// One-time setup: turns a freshly started `mongod --replSet rs0` into a
// single-node replica set. MongoDB only supports multi-document transactions
// on replica sets, and the order worker relies on them.
import mongoose from 'mongoose';

const { MongoClient } = mongoose.mongo;

const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27018/?replicaSet=rs0';
const { hostname, port } = new URL(uri.replace('mongodb://', 'http://'));
const host = `${hostname}:${port || 27017}`;

const client = new MongoClient(`mongodb://${host}/?directConnection=true`, { serverSelectionTimeoutMS: 5000 });
try {
  await client.connect();
  const admin = client.db('admin');
  try {
    const status = await admin.command({ replSetGetStatus: 1 });
    console.log(`Replica set "${status.set}" already initialised (${status.members.length} member).`);
  } catch (err) {
    if (!/no replset config|NotYetInitialized/i.test(err.message + err.codeName)) throw err;
    await admin.command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host }] } });
    console.log(`Initialised replica set rs0 with member ${host}.`);
  }
} finally {
  await client.close();
}
