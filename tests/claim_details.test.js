const test = require('node:test');
const assert = require('node:assert/strict');

const { buildClaimDetails, buildPdfClaimSections, parseClaimDetails } = require('../lib/claim_details');

test('buildClaimDetails totals hospital costs after every component is entered', () => {
  const details = buildClaimDetails({
    claim_category: 'hospital',
    cost_room: '1000000',
    cost_doctor: '250000',
    cost_procedure: '100000',
    cost_medicines: '50000',
    cost_laboratory: '20000',
    cost_radiology: '40000',
    cost_other: '10000',
    hospital_submitted_amount: '1500000',
  });

  assert.equal(details.hospital.guaranteed_total, 1470000);
  assert.equal(details.hospital.submitted_amount, 1500000);
});

test('buildClaimDetails withholds hospital total when a cost is missing or invalid', () => {
  const details = buildClaimDetails({ cost_room: '1000000', cost_doctor: '-5' });

  assert.equal(details.hospital.costs.doctor, null);
  assert.equal(details.hospital.guaranteed_total, null);
});

test('buildClaimDetails normalizes checklist values and verification flags', () => {
  const details = buildClaimDetails({
    document_checklist: ['identity', 'medical'],
    benefit_verified: 'on',
    investigation_required: 'on',
    claim_decision: 'Dalam Investigasi',
  });

  assert.deepEqual(details.verification.document_checklist, ['identity', 'medical']);
  assert.equal(details.verification.benefit_verified, true);
  assert.equal(details.verification.policy_verified, false);
  assert.equal(details.verification.investigation_required, true);
  assert.equal(details.verification.decision, 'Dalam Investigasi');
});

test('parseClaimDetails handles JSON and malformed legacy values', () => {
  assert.deepEqual(parseClaimDetails('{"category":"hospital"}'), { category: 'Klaim Hospital' });
  assert.deepEqual(parseClaimDetails('{invalid'), {});
});

test('buildClaimDetails aligns case type with the granular claim kind', () => {
  const hospital = buildClaimDetails({
    case_type: 'Non Klaim Hospital',
    claim_kind: 'Klaim rawat inap',
  });
  const nonHospital = buildClaimDetails({
    case_type: 'Klaim Hospital',
    claim_kind: 'Klaim Meninggal Dunia',
  });

  assert.equal(hospital.category, 'Klaim Hospital');
  assert.equal(nonHospital.category, 'Non Klaim Hospital');
});

test('buildPdfClaimSections prints hospital costs only for Hospital claims', () => {
  const sections = buildPdfClaimSections(
    { case_type: 'Klaim Hospital' },
    JSON.stringify({
      category: 'Klaim Hospital',
      hospital: {
        costs: { room: 1000000 },
        guaranteed_total: 1000000,
        submitted_amount: 1200000,
      },
      non_hospital: { approved_amount: 500000 },
    }),
  );

  const sectionTitles = sections.map((section) => section.title);
  assert.ok(sectionTitles.includes('RINCIAN KLAIM HOSPITAL'));
  assert.ok(!sectionTitles.includes('RINCIAN KLAIM NON HOSPITAL'));
  assert.equal(
    sections.find((section) => section.title === 'RINCIAN KLAIM HOSPITAL').rows[7].value,
    1000000,
  );
});

test('buildPdfClaimSections prints Non Hospital benefits and uploaded documents', () => {
  const sections = buildPdfClaimSections(
    { case_type: 'Non Klaim Hospital' },
    JSON.stringify({
      category: 'Non Klaim Hospital',
      non_hospital: { requested_sum_insured: 2000000, benefit_amount: 1500000, approved_amount: 1000000 },
      verification: { decision: 'Disetujui' },
    }),
    [{ document_type: 'Dokumen identitas', original_name: 'identitas.pdf' }],
  );

  const sectionTitles = sections.map((section) => section.title);
  assert.ok(sectionTitles.includes('RINCIAN KLAIM NON HOSPITAL'));
  assert.ok(!sectionTitles.includes('RINCIAN KLAIM HOSPITAL'));
  const verification = sections.find((section) => section.title === 'DOKUMEN DAN VERIFIKASI');
  assert.ok(verification.rows.at(-1).value.includes('Dokumen identitas: identitas.pdf'));
});