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

// list tasks (with default limit 40)
app.get("/tools/clickup_list_tasks", async (req, res) => {
  try {
    if (!CLICKUP_API_TOKEN) {
      return res.status(500).json({ error: "CLICKUP_API_TOKEN not set" });
    }

    const { search, list_id, sector } = req.query;
    const includeInvoicing = req.query.include_invoicing === "true";
    const limit = parseInt(req.query.limit || "40", 10);

    const ACTIVE_LISTS = [
      "SALES - Enquiries & Quotations",
      "SALES - Confirmed Orders",
      "DESIGN - Work in progress",
      "PRODUCTION - Work in progress",
      "FITTING - Work in progress"
    ];

    // whatever your completed/invoicing list is actually called, add it here
    const INVOICING_LISTS = [
      "INVOICING",
      "Invoicing",
      "Completed",
      "Closed"
    ];

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

    // 1) active first
    let active = tasks.filter(t => {
      const listName = t.list ? t.list.name : "";
      return ACTIVE_LISTS.includes(listName);
    });

    // 2) apply local search to active
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

    // 2.5) OPTIONAL SECTOR FILTER – ADD THIS BLOCK
    if (sector) {
      const s = sector.toLowerCase();
      active = active.filter(t => {
        return (t.custom_fields || []).some(cf => {
          const name = (cf.name || "").toLowerCase();
          const val = (cf.value || "").toString().toLowerCase();
          // matches any custom field called "Sector" whose value contains the sector
          return name.includes("sector") && val.includes(s);
        });
      });
    }
    
    // 3) sort active newest first
    active = sortByCreatedDesc(active);

    let combined = [...active];
    let invoicing = [];

    // 4) only add invoicing/completed if user asked for it
    if (includeInvoicing) {
      invoicing = tasks.filter(t => {
        const listName = t.list ? t.list.name : "";
        return INVOICING_LISTS.includes(listName);
      });

      if (search) {
        const s = search.toLowerCase();
        invoicing = invoicing.filter(t => {
          const nameMatch = (t.name || "").toLowerCase().includes(s);
          const clientMatch = (t.text_content || "").toLowerCase().includes(s);
          const customMatch = (t.custom_fields || []).some(cf => {
            const val = (cf.value || cf.name || "").toString().toLowerCase();
            return val.includes(s);
          });
          return nameMatch || clientMatch || customMatch;
        });
      }

   // only filter invoicing by sector if the user actually asked for sector
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
      
      invoicing = sortByCreatedDesc(invoicing);
      combined = [...active, ...invoicing];
    }

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
