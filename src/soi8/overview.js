// SOI8 delivery rows -> the five stations of the 3D floor.
//
// A straight port of SOI8-DEL-FINAL-INSPEC-FRONT:
//   lib/page/P01_dashboard_page/P01_overview_logic.dart  (buildOverviewSteps)
//   lib/page/P08_floor3d_page/P08_floor3d_page.dart      (floor3dSteps)
// so both dashboards always show the same numbers. Keep them in step.
//
// Counting rules (no "waiting" any more — anything not finished is in process):
//   STEP 1   Picking          unique delivery_no, all finished
//   STEP 2   Create invoice   per DO: has a real invoice_no (!= delivery_no) = finished
//   STEP 3   Final inspection per DO: invoice_status = COMPLETED = finished
//   STEP 4-1 Customer pick-up per fo_id where carrier_name = CUSTOMER: fo_status = COMPLETED
//   STEP 4-2 Truck delivery   per fo_id otherwise:                     fo_status = COMPLETED
// Customer pick-ups have no FO; SOI8 back puts fo_id = delivery_no for those.

const COMPLETED = 'COMPLETED';

const s = (v) => (v == null ? '' : String(v)).trim();
const isStatus = (v, status) => s(v).toUpperCase() === status;
const hasInvoice = (r) => s(r.invoice_no) !== '' && s(r.invoice_no) !== s(r.delivery_no);
const isCustomer = (r) => s(r.carrier_name).toUpperCase() === 'CUSTOMER';

function groupBy(rows, keyOf) {
  const map = new Map(); // insertion order = SAP order, like the Dart Map
  for (const r of rows) {
    const key = keyOf(r);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

/** Items per station: { title, tag, done }. */
function buildItems(rows) {
  const picking = [];
  const createInv = [];
  const finalInsp = [];

  for (const [doNo, group] of groupBy(rows, (r) => s(r.delivery_no))) {
    const first = group[0];
    const invRow = group.find(hasInvoice) ?? first;
    const hasInv = hasInvoice(invRow);
    const cust = s(first.cust_name);
    const docNo = hasInv ? s(invRow.invoice_no) : doNo;

    picking.push({ title: doNo, tag: cust, done: true });
    createInv.push({ title: docNo, tag: cust, done: hasInv });
    finalInsp.push({
      title: docNo,
      tag: cust,
      done: group.some((r) => isStatus(r.invoice_status, COMPLETED)),
    });
  }

  const customer = [];
  const truck = [];
  for (const [foId, group] of groupBy(rows, (r) => s(r.fo_id) || s(r.delivery_no))) {
    const first = group[0];
    const cust = group.some(isCustomer);
    const plateRow =
      group.find((r) => s(r.driver_plate) && s(r.driver_plate).toUpperCase() !== 'CUSTOMER') ??
      first;
    const plate = s(plateRow.driver_plate).toUpperCase() === 'CUSTOMER' ? '' : s(plateRow.driver_plate);
    const item = {
      title: foId,
      tag: cust ? s(first.cust_name) || plate : plate,
      done: group.some((r) => isStatus(r.fo_status, COMPLETED)),
    };
    (cust ? customer : truck).push(item);
  }

  return { picking, createInv, finalInsp, customer, truck };
}

// Labels mirror what the 3D page already prints; total/finished/inprocess/note
// are what it reads from each step.
const META = {
  step1: { step: 'STEP 1', label: 'Picking', sub: 'Outbound delivery (DO)', unit: 'DO', noun: 'doc' },
  step2: { step: 'STEP 2', label: 'Create invoice', sub: 'Billing document', unit: 'INVOICE', noun: 'doc' },
  step3: { step: 'STEP 3', label: 'Final inspection', sub: 'QA gate before load out', unit: 'INVOICE', noun: 'doc' },
  step41: { step: 'STEP 4-1', label: 'Customer pick-up', sub: 'ลูกค้ามารับของเอง', unit: 'CUSTOMERS', noun: 'customer' },
  step42: { step: 'STEP 4-2', label: 'Truck delivery', sub: 'ส่งของขึ้นรถไปหาลูกค้า', unit: 'TRUCKS', noun: 'truck' },
};

function step(key, items) {
  const m = META[key];
  const open = items.filter((i) => !i.done);
  let note = null;
  if (open.length) {
    const f = open[0];
    const text = f.tag ? `${f.title} ${f.tag}` : f.title;
    note = `${open.length} ${open.length === 1 ? m.noun : `${m.noun}s`} in progress · ${text}`;
  }
  return {
    key,
    step: m.step,
    label: m.label,
    sub: m.sub,
    unit: m.unit,
    total: items.length,
    finished: items.length - open.length,
    inprocess: open.length,
    waiting: 0,
    note,
    live: true,
  };
}

/** The five stations, in the shape /internal/dashboard returns. */
export function overviewSteps(rows) {
  const it = buildItems(rows);
  return [
    step('step1', it.picking),
    step('step2', it.createInv),
    step('step3', it.finalInsp),
    step('step41', it.customer),
    step('step42', it.truck),
  ];
}
