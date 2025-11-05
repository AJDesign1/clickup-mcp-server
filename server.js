import http from "node:http";
import { URL } from "node:url";

// env
const PORT = process.env.PORT || 8080;
const MCP_BEARER = process.env.MCP_BEARER;
const CLICKUP_API_TOKEN = process.env.CLICKUP_API_TOKEN;
const CLICKUP_WORKSPACE_ID = process.env.CLICKUP_WORKSPACE_ID;
const CLICKUP_INVOICING_LIST_ID = process.env.CLICKUP_INVOICING_LIST_ID;

// helper: send JSON
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

// helper: match job number
function matchesJobNumber(task, jobNumber) {
  if (!task || !jobNumber) return false;
  const j = jobNumber.toString().toLowerCase();

  if ((task.name || "").toLowerCase().includes(j)) return true;
  if ((task.text_content || "").toLowerCase().includes(j)) return true;

  const cfs = task.custom_fields || [];
  for (const cf of cfs) {
    const name = (cf.name || "").toLowerCase();
    if (!name.includes("job number")) continue;

    if (typeof cf.value === "string" || typeof cf.value === "number") {
      const val = cf.value.toString().toLowerCase();
      if (val === j || val.includes(j)) return true;
    }

    if (cf.value && typeof cf.value === "object") {
      if (cf.value.label && cf.value.label.toString().toLowerCase().includes(j)) return true;
      if (cf.value.name && cf.value.name.toString().toLowerCase().includes(j)) return true;
    }
  }
  return false;
}

// main server
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    // auth (except /health)
    if (path !== "/health" && MCP_BEARER) {
      const auth = req.headers.authorization || "";
      if (auth !== `Bearer ${MCP_BEARER}`) {
        return sendJson(res, 401, { error: "Unauthorized" });
      }
    }

    // health
    if (path === "/health") {
      return sendJson(res, 200, { ok: true });
    }

    // tools
    if (path === "/tools" && req.method === "GET") {
      return sendJson(res, 200, {
        tools: ["clickup_list_tasks", "clickup_get_task"]
      });
    }

    // debug single
    if (path === "/debug/task" && req.method === "GET") {
      if (!CLICKUP_API_TOKEN || !CLICKUP_WORKSPACE_ID) {
        return sendJson(res, 500, { error: "missing env" });
      }

      const search = url.searchParams.get("search");
      const job_number = url.searchParams.get("job_number");

      const params = new URLSearchParams({
        subtasks: "true",
        archived: "false",
        include_closed: "false",
        order_by: "created",
        reverse: "true",
        limit: "20"
      });
      if (search) {
        params.set("search", search);
      } else if (job_number) {
        params.set("search", job_number.toString());
      }

      const cuRes = await fetch(
        `https://api.clickup.com/api/v2/team/${CLICKUP_WORKSPACE_ID}/task?${params.toString()}`,
        { headers: { Authorization: CLICKUP_API_TOKEN } }
      );

      if (!cuRes.ok) {
        const text = await cuRes.text();
        return sendJson(res, cuRes.status, { error: "ClickUp error", details: text });
      }

      const data = await cuRes.json();
      const tasks = data.tasks || [];
      if (tasks.length === 0) {
        return sendJson(res, 200, { found: false, task: null });
      }
      const t = tasks[0];
      return sendJson(res, 200, {
        found: true,
        id: t.id,
        name: t.name,
        list: t.list ? t.list.name : null,
        custom_fields: t.custom_fields || []
      });
    }

// debug tasks — always return just one task to keep connector lightweight
if (path === "/debug/tasks" && req.method === "GET") {
  try {
    if (!CLICKUP_API_TOKEN || !CLICKUP_WORKSPACE_ID) {
      return sendJson(res, 500, { error: "missing env" });
    }

    const search = url.searchParams.get("search");
    const job_number = url.searchParams.get("job_number");

    const params = new URLSearchParams({
      subtasks: "true",
      archived: "false",
      include_closed: "false",
      order_by: "created",
      reverse: "true",
      limit: "20"   // hard cap so it never returns huge payloads
    });

    if (search) {
      params.set("search", search);
    } else if (job_number) {
      params.set("search", job_number.toString());
    }

    const cuRes = await fetch(
      `https://api.clickup.com/api/v2/team/${CLICKUP_WORKSPACE_ID}/task?${params.toString()}`,
      { headers: { Authorization: CLICKUP_API_TOKEN } }
    );

    if (!cuRes.ok) {
      const text = await cuRes.text();
      return sendJson(res, cuRes.status, { error: "ClickUp error", details: text });
    }

    const data = await cuRes.json();
    const tasks = data.tasks || [];

    if (tasks.length === 0) {
      return sendJson(res, 200, { found: false, task: null });
    }

    const t = tasks[0];
    return sendJson(res, 200, {
      found: true,
      task: {
        id: t.id,
        name: t.name,
        list: t.list ? t.list.name : null,
        custom_fields: t.custom_fields || []
      }
    });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: "debug failed", details: err.message });
  }
}


    // list tasks (main tool)
    if (path === "/tools/clickup_list_tasks" && req.method === "GET") {
      if (!CLICKUP_API_TOKEN) {
        return sendJson(res, 500, { error: "CLICKUP_API_TOKEN not set" });
      }

      const search = url.searchParams.get("search");
      const list_id = url.searchParams.get("list_id");
      const sector = url.searchParams.get("sector");
      const job_number = url.searchParams.get("job_number");
      const includeInvoicing = url.searchParams.get("include_invoicing") === "true";
      const limit = parseInt(url.searchParams.get("limit") || "40", 10);

      const ACTIVE_LISTS = [
        "sales - enquiries & quotations",
        "sales - confirmed orders",
        "design - work in progress",
        "production - work in progress",
        "fitting - work in progress"
      ];

      let cuUrl;
      if (list_id) {
        const params = new URLSearchParams({
          subtasks: "true",
          archived: "false",
          order_by: "created",
          reverse: "true"
        });
        if (search) params.set("search", search);
        else if (job_number) params.set("search", job_number.toString());
        cuUrl = `https://api.clickup.com/api/v2/list/${list_id}/task?${params.toString()}`;
      } else {
        if (!CLICKUP_WORKSPACE_ID) {
          return sendJson(res, 500, { error: "CLICKUP_WORKSPACE_ID not set" });
        }
        const params = new URLSearchParams({
          subtasks: "true",
          archived: "false",
          include_closed: "false",
          order_by: "created",
          reverse: "true"
        });
        if (search) params.set("search", search);
        else if (job_number) params.set("search", job_number.toString());
        cuUrl = `https://api.clickup.com/api/v2/team/${CLICKUP_WORKSPACE_ID}/task?${params.toString()}`;
      }

      const cuRes = await fetch(cuUrl, {
        headers: { Authorization: CLICKUP_API_TOKEN }
      });

      if (!cuRes.ok) {
        const text = await cuRes.text();
        return sendJson(res, cuRes.status, { error: "ClickUp error", details: text });
      }

      const data = await cuRes.json();
      const tasks = data.tasks || [];

      const sortByCreatedDesc = arr =>
        arr.sort((a, b) => Number(b.date_created || 0) - Number(a.date_created || 0));

      let active;
      if (job_number) {
        active = tasks;
      } else {
        active = tasks.filter(t => {
          const listName = (t.list ? t.list.name : "").toLowerCase();
          return ACTIVE_LISTS.includes(listName);
        });
      }

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

      if (job_number) {
        active = active.filter(t => matchesJobNumber(t, job_number));
      }

      active = sortByCreatedDesc(active);

      let invoicing = [];
      if ((includeInvoicing || job_number) && CLICKUP_INVOICING_LIST_ID) {
        const params = new URLSearchParams({
          subtasks: "true",
          archived: "false",
          order_by: "created",
          reverse: "true",
          page: "0",
          limit: "100"
        });
        if (search) params.set("search", search);
        else if (job_number) params.set("search", job_number.toString());

        const invRes = await fetch(
          `https://api.clickup.com/api/v2/list/${CLICKUP_INVOICING_LIST_ID}/task?${params.toString()}`,
          { headers: { Authorization: CLICKUP_API_TOKEN } }
        );
        if (invRes.ok) {
          const invData = await invRes.json();
          invoicing = invData.tasks || [];
        }

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

        if (job_number) {
          invoicing = invoicing.filter(t => matchesJobNumber(t, job_number));
        }

        invoicing = sortByCreatedDesc(invoicing);
      }

      let combined = [...active];
      if ((includeInvoicing || job_number) && CLICKUP_INVOICING_LIST_ID) {
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

      return sendJson(res, 200, {
        items,
        total_returned: items.length,
        active_count: active.length,
        invoicing_count: invoicing.length,
        invoicing_included: includeInvoicing || job_number
      });
    }

    // get single task
    if (path === "/tools/clickup_get_task" && req.method === "GET") {
      const task_id = url.searchParams.get("task_id");
      if (!task_id) {
        return sendJson(res, 400, { error: "task_id is required" });
      }
      if (!CLICKUP_API_TOKEN) {
        return sendJson(res, 500, { error: "CLICKUP_API_TOKEN not set" });
      }

      const cuRes = await fetch(
        `https://api.clickup.com/api/v2/task/${task_id}`,
        { headers: { Authorization: CLICKUP_API_TOKEN } }
      );

      if (!cuRes.ok) {
        const text = await cuRes.text();
        return sendJson(res, cuRes.status, { error: "ClickUp error", details: text });
      }

      const task = await cuRes.json();
      return sendJson(res, 200, {
        id: task.id,
        name: task.name,
        url: task.url,
        status: task.status?.status,
        list: task.list ? task.list.name : null,
        custom_fields: task.custom_fields || []
      });
    }

    // fallback
    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: "Server error", details: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`HTTP ClickUp MCP wrapper (no-express) listening on ${PORT}`);
});
