export interface EvaluationIndicator {
  id: number
  label: string
  satisfaction: number
}

export interface KonsultasiKualitas {
  id: number
  rincian_data: string
  status_data: number
  kualitas: number | null
}

export interface EvaluationVisitor {
  nama: string | null
  nama_instansi: string | null
  nomor_antrian: string | null
  jenis_layanan: string | null
  date_visit: string | null
}

/** Satu entri antrian evaluasi (kartu pemilihan di terminal standby). */
export interface EvaluationPendingItem {
  id_kunjungan: number
  nama: string | null
  nama_instansi: string | null
  nomor_antrian: string | null
  jenis_layanan: string | null
  date_visit: string | null
}

export interface EvaluationFormData {
  indicators: EvaluationIndicator[]
  konsultasiKualitas: KonsultasiKualitas[]
  visitor: EvaluationVisitor | null
}

export interface EvaluationSubmission {
  indicators: { id: number; satisfaction: number }[]
  overall_score: number
  kualitas_per_konsultasi?: Record<number, number>
}

/** One row from tamdes_evaluasi_detail — kepentingan is deprecated (always NULL now). */
export interface EvaluationDetailRow {
  id: number
  id_kunjungan: number
  indikator_id: number
  kepentingan: number | null
  kepuasan: number
}

/**
 * Actual shape returned by GET /api/evaluations/:id/results.
 * `indikator` is a Record<indikator_id_as_string, label>.
 */
export interface EvaluationResult {
  rating_pengunjung: number | null
  status: string
  durasi_detik: number | null
  details: EvaluationDetailRow[]
  indikator: Record<string, string>
}
