const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const TODOIST_TOKEN = process.env.TODOIST_TOKEN;

app.get('/tasks', async (req, res) => {
  try {
    const [tasksRes, projectsRes] = await Promise.all([
      fetch('https://api.todoist.com/api/v1/tasks', {
        headers: { 'Authorization': `Bearer ${TODOIST_TOKEN}` }
      }),
      fetch('https://api.todoist.com/api/v1/projects', {
        headers: { 'Authorization': `Bearer ${TODOIST_TOKEN}` }
      })
    ]);
    const tasksData = await tasksRes.json();
    const projectsData = await projectsRes.json();
    res.json({ tasks: tasksData.results || tasksData, projects: projectsData.results || projectsData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/tasks/:id/close', async (req, res) => {
  try {
    await fetch(`https://api.todoist.com/api/v1/tasks/${req.params.id}/close`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TODOIST_TOKEN}` }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
