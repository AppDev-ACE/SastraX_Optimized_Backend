import { redis } from "./redisClient.js";

export const saveSession = async (token, data) => {
  await redis.set(
    `session:${token}`,
    JSON.stringify(data),
    { EX: 10368000 }
  );
};

export const getSession = async (token) => {
  const data = await redis.get(`session:${token}`);
  return data ? JSON.parse(data) : null;
};

export const updateSessionCookies = async (token, cookies) => {
  const session = await getSession(token);
  if (!session) return null;

  session.cookies = cookies;

  await saveSession(token, session);
};