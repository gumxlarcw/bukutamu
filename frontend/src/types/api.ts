export interface ApiResponse<T> {
  success: boolean
  data: T
  message: string
}

export interface PaginatedResponse<T> {
  success: boolean
  data: T[]
  message: string
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

/**
 * Hitungan per status untuk kartu ringkasan antrian. Kuncinya cermin persis
 * enum kolom `tamdes_kunjungan.status` (7 nilai) — dihitung di SERVER atas
 * seluruh himpunan hasil, BUKAN di klien atas halaman yang sedang dibuka,
 * karena halaman antrian berpaginasi. Filter status sengaja diabaikan saat
 * menghitung supaya kartu tetap memperlihatkan gambaran utuh.
 */
export interface QueueCounts {
  antri: number
  dipanggil: number
  proses: number
  diproses: number
  menunggu_evaluasi: number
  evaluasi_selesai: number
  selesai: number
}

/** Respons daftar antrian: paginasi + hitungan status. */
export type QueueListResponse<T> = PaginatedResponse<T> & { counts: QueueCounts }
