const optionalAmount = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
};

const CASE_TYPES = ['Klaim Hospital', 'Klaim Non Hospital', 'Klaim Campuran'];

const normalizeCaseType = (value) => {
  if (value === 'hospital' || value === 'Klaim Hospital') return 'Klaim Hospital';
  if (value === 'non_hospital' || value === 'Klaim Non Hospital') return 'Klaim Non Hospital';
  if (value === 'Klaim Campuran') return 'Klaim Campuran';
  return '';
};

const caseTypeForClaimKind = (claimKind) => {
  if (['Klaim rawat inap', 'Klaim perawatan 1 hari'].includes(claimKind)) {
    return 'Klaim Hospital';
  }
  if (['Klaim Meninggal Dunia', 'Klaim Penyakit Kritis', 'Credit Life'].includes(claimKind)) {
    return 'Klaim Non Hospital';
  }
  return '';
};

const parseClaimDetails = (value) => {
  if (!value) return {};
  if (typeof value === "object") {
    return { ...value, category: normalizeCaseType(value.category) };
  }
  if (typeof value !== "string") return {};

  try {
    const parsed = JSON.parse(value) || {};
    return { ...parsed, category: normalizeCaseType(parsed.category) };
  } catch (error) {
    return {};
  }
};

const buildClaimDetails = (body) => {
  const claimKind = body.claim_kind || "";
  const requestedCategory = normalizeCaseType(body.case_type || body.claim_category);
  const category = requestedCategory === 'Klaim Campuran'
    ? requestedCategory
    : caseTypeForClaimKind(claimKind) || requestedCategory;
  const hospitalCosts = {
    room: optionalAmount(body.cost_room),
    doctor: optionalAmount(body.cost_doctor),
    procedure: optionalAmount(body.cost_procedure),
    medicines: optionalAmount(body.cost_medicines),
    laboratory: optionalAmount(body.cost_laboratory),
    radiology: optionalAmount(body.cost_radiology),
    other: optionalAmount(body.cost_other),
  };
  const hospitalTotal = Object.values(hospitalCosts).reduce(
    (total, value) => total + (value || 0),
    0,
  );
  const allHospitalCostsProvided = Object.values(hospitalCosts).every(
    (value) => value !== null,
  );
  const checklist = body.document_checklist
    ? Array.isArray(body.document_checklist)
      ? body.document_checklist
      : [body.document_checklist]
    : [];

  return {
    category,
    hospital: {
      costs: hospitalCosts,
      guaranteed_total: allHospitalCostsProvided ? hospitalTotal : null,
      submitted_amount: optionalAmount(body.hospital_submitted_amount),
    },
    non_hospital: {
      requested_sum_insured: optionalAmount(body.non_hospital_sum_insured),
      benefit_amount: optionalAmount(body.non_hospital_benefit),
      approved_amount: optionalAmount(body.non_hospital_approved),
    },
    policy: {
      payer: body.policy_payer || "",
      status_at_claim: body.policy_status_at_claim || "",
      claimed_benefit: body.policy_claimed_benefit || "",
      sum_insured: optionalAmount(body.policy_sum_insured),
    },
    claim: {
      number: body.claim_number || "",
      critical_illness: body.critical_illness || "",
      diagnosis_date: body.diagnosis_date || "",
      admission_date: body.admission_date || "",
      kind: claimKind,
      incident_date: body.incident_date || "",
      death_date: body.tanggal_meninggal || "",
      death_place: body.tempat_meninggal || "",
      beneficiary_relationship: body.beneficiary_relationship || "",
      beneficiary_data: body.beneficiary_data || "",
    },
    verification: {
      document_checklist: checklist,
      benefit_verified: body.benefit_verified === "on",
      policy_verified: body.policy_verified === "on",
      investigation_required: body.investigation_required === "on",
      decision: body.claim_decision || "",
      assessor_notes: body.assessor_notes || "",
    },
  };
};

const buildPdfClaimSections = (caseData, claimDetails, documents = []) => {
  const details = parseClaimDetails(claimDetails);
  const category = normalizeCaseType(caseData.case_type || details.category);
  const claim = details.claim || {};
  const policy = details.policy || {};
  const verification = details.verification || {};
  const rows = (entries) => entries.map(([label, value]) => ({
    label,
    value: value === undefined || value === null || value === "" ? "-" : value,
  }));

  const sections = [
    {
      title: "DATA KLAIM",
      rows: rows([
        ["ID Case", caseData.case_number || `#${caseData.id || "-"}`],
        ["Judul Case", caseData.title],
        ["Status Case", caseData.status],
        ["Prioritas", caseData.priority],
        ["Case Type", category],
        ["No. Klaim", claim.number],
        ["Jenis Klaim", claim.kind],
        ["Penyakit Kritis", claim.critical_illness],
        ["Tanggal Diagnosis Dokter", claim.diagnosis_date],
        ["Tanggal Rawat Inap", claim.admission_date],
        ["Tanggal Kejadian Klaim", claim.incident_date],
        ["Tanggal Meninggal", caseData.tanggal_meninggal || claim.death_date],
        ["Tempat Meninggal", caseData.tempat_meninggal || claim.death_place],
        ["Hubungan dengan Pemegang Polis", claim.beneficiary_relationship],
        ["Data Penerima Manfaat", claim.beneficiary_data],
      ]),
    },
    {
      title: "INFORMASI POLIS TAMBAHAN",
      rows: rows([
        ["Pembayar Polis", policy.payer],
        ["Status Polis saat Klaim", policy.status_at_claim],
        ["Manfaat yang Diklaim", policy.claimed_benefit],
        ["Nilai Pertanggungan", policy.sum_insured],
      ]),
    },
  ];

  if (category === "Klaim Hospital" || category === "Klaim Campuran") {
    const costs = details.hospital?.costs || {};
    sections.push({
      title: "RINCIAN KLAIM HOSPITAL",
      rows: rows([
        ["Kamar Rawat Inap", costs.room],
        ["Biaya Dokter", costs.doctor],
        ["Tindakan/Prosedur Medis", costs.procedure],
        ["Obat-obatan", costs.medicines],
        ["Laboratorium", costs.laboratory],
        ["Radiologi", costs.radiology],
        ["Aneka Perawatan/Lainnya", costs.other],
        ["Total Biaya Dijaminkan", details.hospital?.guaranteed_total],
        ["Klaim yang Diajukan", details.hospital?.submitted_amount],
      ]),
    });
  }
  if (category === "Klaim Non Hospital" || category === "Klaim Campuran") {
    sections.push({
      title: "RINCIAN KLAIM NON HOSPITAL",
      rows: rows([
        ["Uang Pertanggungan yang Diajukan", details.non_hospital?.requested_sum_insured],
        ["Manfaat Nominal Klaim", details.non_hospital?.benefit_amount],
        ["Klaim yang Disetujui", details.non_hospital?.approved_amount],
      ]),
    });
  }

  sections.push({
    title: "DOKUMEN DAN VERIFIKASI",
    rows: rows([
      ["Checklist Kelengkapan Dokumen", (verification.document_checklist || []).join(", ")],
      ["Verifikasi Manfaat", verification.benefit_verified ? "Terverifikasi" : "Belum"],
      ["Verifikasi Polis", verification.policy_verified ? "Terverifikasi" : "Belum"],
      ["Investigasi", verification.investigation_required ? "Diperlukan" : "Tidak diperlukan"],
      ["Keputusan Klaim", verification.decision],
      ["Catatan Klaim Assessor", verification.assessor_notes],
      ["Dokumen Terunggah", documents.map((document) =>
        `${document.document_type || "Dokumen pendukung"}: ${document.original_name}`,
      ).join("\n")],
    ]),
  });

  return sections;
};

module.exports = { buildClaimDetails, parseClaimDetails, buildPdfClaimSections, CASE_TYPES };