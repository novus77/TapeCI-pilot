import pg from "pg";
const client = new pg.Client({ connectionString: "postgres://tapeci:tapeci@127.0.0.1:55432/tapeci" });
await client.connect();
const rows = await client.query(
  "select id,state,commit_sha,artifact_sha256,error_code,requested_at from deployments order by requested_at desc limit 5",
);
console.log(JSON.stringify(rows.rows, null, 2));
const events = await client.query(
  "select deployment_id,old_state,new_state,event_type,created_at from deployment_events order by id desc limit 8",
);
console.log(JSON.stringify(events.rows, null, 2));
await client.end();
