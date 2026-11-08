import mongoose from "mongoose";
import { MongoClient } from "mongodb";
import { createAuth } from "../auth/auth.js";

export async function connectDatabases(config) {
  const mongoClient = new MongoClient(config.MONGODB_URI);

  try {
    await mongoClient.connect();
    await mongoose.connect(config.MONGODB_URI, {
      dbName: config.MONGODB_DATABASE,
    });

    const database = mongoClient.db(config.MONGODB_DATABASE);
    const auth = createAuth({ database, mongoClient, config });

    return {
      auth,
      database,
      async close() {
        await Promise.all([mongoose.disconnect(), mongoClient.close()]);
      },
    };
  } catch (error) {
    await Promise.allSettled([mongoose.disconnect(), mongoClient.close()]);
    throw new Error("Could not connect Restora to MongoDB", { cause: error });
  }
}
