import type { ReactNode } from 'react'
import { Inbox, BellRing, Clock, Hourglass, CircleCheck } from 'lucide-react'
import type { QueueCounts } from '@/types/api'

/**
 * Definisi tahapan kartu ringkasan antrian. Dipisahkan dari komponennya karena
 * aturan `react-refresh/only-export-components`: satu berkas tidak boleh
 * mengekspor komponen sekaligus konstanta.
 */
export interface QueueStage {
  label: string
  /** Status yang dijumlahkan ke kartu ini. Kuncinya cermin enum tamdes_kunjungan.status. */
  statuses: (keyof QueueCounts)[]
  icon: ReactNode
  accent?: 'primary' | 'secondary'
}

/**
 * Tahapan Antrian PST (SKD) — 6 kartu, menutup ketujuh nilai enum.
 * SKD wajib melewati evaluasi tablet sebelum bisa `selesai`, jadi dua tahap
 * evaluasi tampil terpisah: mana yang menunggu pengunjung mengisi, dan mana
 * yang sudah diisi tapi menunggu petugas menutup.
 */
export const TAHAP_SKD: QueueStage[] = [
  { label: 'Antri',             statuses: ['antri'],              icon: <Inbox className="w-5 h-5" />,       accent: 'secondary' },
  { label: 'Dipanggil',         statuses: ['dipanggil'],          icon: <BellRing className="w-5 h-5" />,    accent: 'primary' },
  { label: 'Diproses',          statuses: ['proses', 'diproses'], icon: <Clock className="w-5 h-5" />,       accent: 'primary' },
  { label: 'Menunggu Evaluasi', statuses: ['menunggu_evaluasi'],  icon: <Hourglass className="w-5 h-5" />,   accent: 'secondary' },
  { label: 'Perlu Ditutup',     statuses: ['evaluasi_selesai'],   icon: <CircleCheck className="w-5 h-5" />, accent: 'secondary' },
  { label: 'Selesai',           statuses: ['selesai'],            icon: <CircleCheck className="w-5 h-5" />, accent: 'primary' },
]

/**
 * Tahapan Antrian DTSEN — 4 kartu. DTSEN TIDAK melewati evaluasi:
 * `next_status_after_completion` mengarahkannya langsung ke `selesai`, dan
 * gerbang #21 di Consultations::detail menolak `menunggu_evaluasi` untuk layanan
 * non-SKD. Karena itu tahap evaluasi tidak ditampilkan di sini.
 * `evaluasi_selesai` tetap dijumlahkan ke Selesai supaya tidak ada yang hilang
 * seandainya data lama pernah memakainya.
 */
export const TAHAP_DTSEN: QueueStage[] = [
  { label: 'Antri',     statuses: ['antri'],                       icon: <Inbox className="w-5 h-5" />,       accent: 'secondary' },
  { label: 'Dipanggil', statuses: ['dipanggil'],                   icon: <BellRing className="w-5 h-5" />,    accent: 'primary' },
  { label: 'Diproses',  statuses: ['proses', 'diproses'],          icon: <Clock className="w-5 h-5" />,       accent: 'primary' },
  { label: 'Selesai',   statuses: ['selesai', 'evaluasi_selesai'], icon: <CircleCheck className="w-5 h-5" />, accent: 'primary' },
]
