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

export interface EvaluationResult {
  visit_id: number
  guest_nama: string
  indicators: EvaluationIndicator[]
  overall_score: number
  submitted_at: string
}
