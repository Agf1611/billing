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
  'views/admin/backup.ejs',
  'views/admin/olts.ejs',
  'views/admin/settings.ejs',
  'views/admin/update.ejs',
  'views/admin/technician_tasks.ejs',
  'views/collector/login.ejs',
  'views/agent/login.ejs',
  'views/tech/login.ejs'
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

const techCustomersFile = path.join(root, 'views/tech/customers.ejs');
const techCustomersSrc = fs.readFileSync(techCustomersFile, 'utf8');
ejs.render(techCustomersSrc, {
  title: 'Pelanggan',
  company: 'ISP',
  activePage: 'customers',
  techName: 'Teknisi',
  techNav: { openTickets: 0, myTickets: 0, assignedTasks: 0, inProgress: 0, resolved: 0 },
  operationalTasks: [],
  customers: [],
  search: '',
  filterStatus: '',
  msg: null,
  lang: 'id',
  t: (_key, fallback) => fallback || ''
}, { filename: techCustomersFile });
console.log('OK views/tech/customers.ejs');

const collectorDashboardFile = path.join(root, 'views/collector/dashboard.ejs');
const collectorDashboardSrc = fs.readFileSync(collectorDashboardFile, 'utf8');
ejs.render(collectorDashboardSrc, {
  title: 'Dashboard Kolektor',
  company: 'ISP',
  month: 5,
  year: 2026,
  status: 'unpaid',
  search: '',
  scope: '',
  todayDay: 10,
  summary: {
    today_count: 1,
    today_total: 150000,
    unpaid_count: 4,
    unpaid_total: 600000,
    isolir_count: 2,
    isolir_total: 300000,
    multi_customer_count: 1,
    multi_total: 450000
  },
  invoices: [],
  pendingMap: new Map(),
  myReqs: [],
  msg: null,
  lang: 'id'
}, { filename: collectorDashboardFile });
console.log('OK views/collector/dashboard.ejs');
