import express from "express";
import fetch from "node-fetch";

const app = express();

// env
const PORT = process.env.PORT || 8080;
const MCP_BEARER = process.env.MCP_BEARER;
const CLICKUP_API_TOKEN = process.env.CLICKUP_API_TOKEN;
const CLICKUP_WORKSPACE_ID = process.env.CLICKUP_WORKSPACE_ID;
const CLICKUP_INVOICING_LIST_ID = process.env.CLICKUP_INVOICING_LIST_ID;

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

// debug: show first tasks + custom fields
app.get("/debug/tasks", async (req, res) => {
  try {
    if (!CLICKUP_API_TOKEN || !CLICKUP_WORKSPACE_ID) {
      return res.status(500).json({ error: "missing env" });
    }

    const params = new URLSearchParams({
      subtasks: "true",
      archived: "false",
      include_closed: "false",
      order_by: "created",
      reverse: "true",
      limit: req.query.limit || "100"
    });

    const url = `https://api.clickup.com/api/v2/team/${CLICKUP_WORKSPACE_ID}/task?${params.toString()}`;
    const cuRes = await fetch(url, {
      headers: { Authorization: CLICKUP_API_TOKEN }
    });
    const data = await cuRes.json();
    const tasks = data.tasks || [];

    const slim = tasks.map(t => ({
      id: t.id,
      name: t.name,
      list: t.list ? t.list.name : null,
      custom_fields: t.custom_fields || []
    }));

    res.json({ count: slim.length, tasks: slim });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "debug failed", details: err.message });
  }
});

// helper: match job number in name/desc/custom field
function matchesJobNumber(task, jobNumber) {
  if (!task || !jobNumber) return false;
  const j = jobNumber.toString().toLowerCase();

  // task name
  if ((task.name || "").toLowerCase().includes(j)) return true;

  // task description
  if ((task.text_content || "").toLowerCase().includes(j)) return true;

  // custom fields
  const cfs = task.custom_fields || [];
  for (const cf of cfs) {
    const name = (cf.name || "").toLowerCase();
    if (!name.includes("job number")) continue;

    // plain value
    if (typeof cf.value === "string" || typeof cf.value === "number") {
      const val = cf.value.toString().toLowerCase();
      if (val === j || val.includes(j)) return true;
    }

    // structured value
    if (cf.value && typeof cf.value === "object") {
      if (cf.value.label && cf.value.label.toString().toLowerCase().includes(j)) return true;
      if (cf.value.name && cf.value.name.toString().toLowerCase().includes(j)) return true;
    }
  }

  return false;
}

// list tasks
app.get("/tools/clickup_list_tasks", async (req, res) => {
  try {
    if (!CLICKUP_API_TOKEN) {
      return res.status(500).json({ error: "CLICKUP_API_TOKEN not set" });
    }

    const { search, list_id, sector, job_number } = req.query;
    const includeInvoicing = req.query.include_invoicing === "true";
    const limit = parseInt(req.query.limit || "40", 10);

    // lists we care about (names from your setup, lowercased)
    const ACTIVE_LISTS = [
      "sales - enquiries & quotations",
      "sales - confirmed orders",
      "design - work in progress",
      "production - work in progress",
      "fitting - work in progress"
    ];

    // 1) fetch tasks (either from specific list or whole team)
    let url;
    if (list_id) {
      const params = new URLSearchParams({
        subtasks: "true",
        archived: "false",
        order_by: "created",
        reverse: "true"
      });
      if (search) params.set("search", search);
      url = `https://api.clickup.com/api/v2/list/${list_id}/task?${params.toString()}`;
    } else {
      if (!CLICKUP_WORKSPACE_ID) {
        return res.status(500).json({ error: "CLICKUP_WORKSPACE_ID not set" });
      }
      const params = new URLSearchParams({
        subtasks: "true",
        archived: "false",
        include_closed: "false",
        order_by: "created",
        reverse: "true"
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
      return res.status(cuRes.status).json({ error: "ClickUp error", details: text });
    }

    const data = await cuRes.json();
    const tasks = data.tasks || [];

    const sortByCreatedDesc = arr =>
      arr.sort((a, b) => Number(b.date_created || 0) - Number(a.date_created || 0));

    // 2) choose starting set
    let active;
    if (job_number) {
      // job number searches should look across everything we fetched
      active = tasks;
    } else {
      // normal behaviour: only your active lists
      active = tasks.filter(t => {
        const listName = (t.list ? t.list.name : "").toLowerCase();
        return ACTIVE_LISTS.includes(listName);
      });
    }

    // 3) apply local search
    if (search) {
      const s = search.toLowerCase();
      active = active.filter(t => {
        const nameMatch = (t.name || "").toLowerCase().includes(s);
        const clientMatch = (t.text_content || "").toLowerCase().includes(s);
        const customMatch = (t.custom_fields || []).some(cf => {
          const val = (cf.value || cf.name || "").toString().toLowerCase();
          return val.includes(s);
        });
        return nameMatch || clientMatch || customMatch;
      });
    }

    // 4) sector filter
    if (sector) {
      const s = sector.toLowerCase();
      active = active.filter(t => {
        return (t.custom_fields || []).some(cf => {
          const name = (cf.name || "").toLowerCase();
          const val = (cf.value || "").toString().toLowerCase();
          return name.includes("sector") && val.includes(s);
        });
      });
    }

    // 5) job number filter
    if (job_number) {
      active = active.filter(t => matchesJobNumber(t, job_number));
    }

    // 6) sort active newest first
    active = sortByCreatedDesc(active);

    // 7) optionally fetch invoicing separately (capped)
    let invoicing = [];
    if (includeInvoicing && CLICKUP_INVOICING_LIST_ID) {
      const params = new URLSearchParams({
        subtasks: "true",
        archived: "false",
        order_by: "created",
        reverse: "true",
        page: "0",
        limit: "100"
      });
      if (search) params.set("search", search);
      const invRes = await fetch(
        `https://api.clickup.com/api/v2/list/${CLICKUP_INVOICING_LIST_ID}/task?${params.toString()}`,
        { headers: { Authorization: CLICKUP_API_TOKEN } }
      );
      if (invRes.ok) {
        const invData = await invRes.json();
        invoicing = invData.tasks || [];
      }

      // sector on invoicing
      if (sector) {
        const s = sector.toLowerCase();
        invoicing = invoicing.filter(t => {
          return (t.custom_fields || []).some(cf => {
            const name = (cf.name || "").toLowerCase();
            const val = (cf.value || "").toString().toLowerCase();
            return name.includes("sector") && val.includes(s);
          });
        });
      }

      // job number on invoicing
      if (job_number) {
        invoicing = invoicing.filter(t => matchesJobNumber(t, job_number));
      }

      invoicing = sortByCreatedDesc(invoicing);
    }

    // 8) combine
    let combined = [...active];
    if (includeInvoicing && CLICKUP_INVOICING_LIST_ID) {
      combined = [...active, ...invoicing];
    }

    // 9) limit & shape
    const limited = combined.slice(0, limit);

    const items = limited.map(t => ({
      id: t.id,
      name: t.name,
      url: t.url,
      status: t.status?.status,
      list: t.list ? t.list.name : null,
      custom_fields: t.custom_fields || [],
      date_created: t.date_created || null
    }));

    res.json({
      items,
      total_returned: items.length,
      active_count: active.length,
      invoicing_count: invoicing.length,
      invoicing_included: includeInvoicing
    });
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
