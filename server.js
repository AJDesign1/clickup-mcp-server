import express from "express";
import fetch from "node-fetch";

const app = express();

// env
const PORT = process.env.PORT || 8080;
const MCP_BEARER = process.env.MCP_BEARER;
const CLICKUP_API_TOKEN = process.env.CLICKUP_API_TOKEN;
const CLICKUP_WORKSPACE_ID = process.env.CLICKUP_WORKSPACE_ID;

app.use(express.json());

// auth middleware (let /health through)
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (!MCP_BEARER) return next(); // if no bearer is set, don't block
  const auth = req.headers.authorization || "";
  if (auth === `Bearer ${MCP_BEARER}`) return next();
  return res.status(401).json({ error: "Unauthorized" });
});

// health check
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// list tools
app.get("/tools", (req, res) => {
  res.json({
    tools: ["clickup_list_tasks", "clickup_get_task"]
  });
});

// list tasks (with default limit 5)
app.get("/tools/clickup_list_tasks", async (req, res) => {
  try {
    if (!CLICKUP_API_TOKEN) {
      return res.status(500).json({ error: "CLICKUP_API_TOKEN not set" });
    }

    const { search, list_id } = req.query;
    // default to 5 to avoid big payloads
    const limit = parseInt(req.query.limit || "5", 10);

    let url;

    if (list_id) {
      // list-specific tasks
      const params = new URLSearchParams({
        subtasks: "true",
        archived: "false"
      });
      if (search) params.set("search", search);
      url = `https://api.clickup.com/api/v2/list/${list_id}/task?${params.toString()}`;
    } else {
      // workspace/team level
      if (!CLICKUP_WORKSPACE_ID) {
        return res.status(500).json({ error: "CLICKUP_WORKSPACE_ID not set" });
      }
      const params = new URLSearchParams({
        subtasks: "true",
        archived: "false",
        include_closed: "false"
      });
      if (search) params.set("search", search);
      url = `https://api.clickup.com/api/v2/team/${CLICKUP_WORKSPACE_ID}/task?${params.toString()}`;
    }

    const cuRes = await fetch(url, {
      headers: {
        Authorization: CLICKUP_API_TOKEN
      }
    });

    if (!cuRes.ok) {
      const text = await cuRes.text();
      return res
        .status(cuRes.status)
        .json({ error: "ClickUp error", details: text });
    }

    const data = await cuRes.json();
    const tasks = data.tasks || [];

    // apply limit
    const limited = tasks.slice(0, limit);

    const items = limited.map((t) => ({
      id: t.id,
      name: t.name,
      url: t.url,
      status: t.status?.status,
      list: t.list ? t.list.name : null,
      custom_fields: t.custom_fields || []
    }));

    res.json({ items, total_returned: items.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// get single task
app.get("/tools/clickup_get_task", async (req, res) => {
  try {
    const { task_id } = req.query;
    if (!task_id) {
      return res.status(400).json({ error: "task_id is required" });
    }
    if (!CLICKUP_API_TOKEN) {
      return res.status(500).json({ error: "CLICKUP_API_TOKEN not set" });
    }

    const cuRes = await fetch(
      `https://api.clickup.com/api/v2/task/${task_id}`,
      {
        headers: {
          Authorization: CLICKUP_API_TOKEN
        }
      }
    );

    if (!cuRes.ok) {
      const text = await cuRes.text();
      return res
        .status(cuRes.status)
        .json({ error: "ClickUp error", details: text });
    }

    const task = await cuRes.json();

    res.json({
      id: task.id,
      name: task.name,
      url: task.url,
      status: task.status?.status,
      list: task.list ? task.list.name : null,
      custom_fields: task.custom_fields || []
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`HTTP ClickUp MCP wrapper listening on ${PORT}`);
});
