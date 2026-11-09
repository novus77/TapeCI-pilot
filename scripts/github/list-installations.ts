import pg from "pg";

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://tapeci:tapeci@127.0.0.1:55432/tapeci",
});
await client.connect();
const result = await client.query(
  "select installation_id, account_login, suspended_at, deleted_at from github_installations order by created_at",
);
console.log(JSON.stringify(result.rows, null, 2));
await client.end();
