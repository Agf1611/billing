const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const root = path.resolve(__dirname, '..');
const views = [
  'views/login.ejs',
  'views/dashboard.ejs',
  'views/static_qris_payment.ejs',
  'views/public_check_billing.ejs',
  'views/admin/customer_requests.ejs',
  'views/admin/settings.ejs',
  'views/admin/update.ejs',
  'views/admin/technician_tasks.ejs'
];

for (const rel of views) {
  const file = path.join(root, rel);
  const src = fs.readFileSync(file, 'utf8');
  ejs.compile(src, { filename: file });
  console.log(`OK ${rel}`);
}

const techDashboardFile = path.join(root, 'views/tech/dashboard.ejs');
const techDashboardSrc = fs.readFileSync(techDashboardFile, 'utf8');
ejs.render(techDashboardSrc, {
  title: 'Dashboard Teknisi',
  company: 'ISP',
  activePage: 'dashboard',
  techName: 'Teknisi',
  techNav: { openTickets: 0, myTickets: 0, inProgress: 0, resolved: 0 },
  stats: { inProgress: 0, resolved: 0, taskAssigned: 0, taskDueToday: 0 },
  operationalTasks: [],
  tickets: [],
  msg: null,
  lang: 'id',
  t: (_key, fallback) => fallback || ''
}, { filename: techDashboardFile });
console.log('OK views/tech/dashboard.ejs');

const techTasksFile = path.join(root, 'views/tech/tasks.ejs');
const techTasksSrc = fs.readFileSync(techTasksFile, 'utf8');
ejs.render(techTasksSrc, {
  title: 'Job Lapangan',
  company: 'ISP',
  activePage: 'tasks',
  techName: 'Teknisi',
  techNav: { openTickets: 0, myTickets: 0, assignedTasks: 0, inProgress: 0, resolved: 0 },
  stats: { taskAssigned: 0, taskInProgress: 0, taskDueToday: 0, taskDone: 0 },
  filterStatus: 'all',
  tasks: [],
  msg: null,
  lang: 'id',
  t: (_key, fallback) => fallback || ''
}, { filename: techTasksFile });
console.log('OK views/tech/tasks.ejs');
