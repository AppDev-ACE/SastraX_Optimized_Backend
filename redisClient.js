import { createClient } from 'redis';

export const redis = createClient({
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD,
    socket: {
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT
    }
});

redis.on('error', err => console.log('Redis Client Error', err));

await redis.connect();