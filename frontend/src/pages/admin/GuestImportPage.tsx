import { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { guestsApi } from '@/api/guests'
import type { Guest } from '@/types/guest'
import { Button } from '@/components/ui/button'
import { ArrowLeft, Upload, FileText, CheckCircle, AlertCircle } from 'lucide-react'

interface ParsedRow {
  nama: string
  email: string
  notel: string
  jeniskelamin: string
  pendidikan: string
  pekerjaan: string
  kategori_instansi: string
  nama_instansi: string
  [key: string]: string
}

function parseCsv(text: string): ParsedRow[] {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length < 2) return []
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim().toLowerCase())
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.replace(/^"|"$/g, '').trim())
    const row: Record<string, string> = {}
    headers.forEach((h, i) => { row[h] = vals[i] ?? '' })
    return row as ParsedRow
  }).filter(r => r.nama)
}

export default function GuestImportPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [rows, setRows] = useState<ParsedRow[]>([])
  const [fileName, setFileName] = useState('')
  const [results, setResults] = useState<{ success: number; failed: number }>({ success: 0, failed: 0 })
  const [importing, setImporting] = useState(false)
  const [done, setDone] = useState(false)

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = ev => {
      const parsed = parseCsv(ev.target?.result as string)
      setRows(parsed)
      setDone(false)
      setResults({ success: 0, failed: 0 })
    }
    reader.readAsText(file)
  }

  const handleImport = async () => {
    setImporting(true)
    let success = 0, failed = 0
    for (const row of rows) {
      try {
        // CSV cells are all strings; the backend coerces them. Cast through
        // unknown because ParsedRow's string index signature doesn't overlap
        // the numeric fields in Partial<Guest>.
        await guestsApi.create(row as unknown as Partial<Guest>)
        success++
      } catch {
        failed++
      }
    }
    setResults({ success, failed })
    setImporting(false)
    setDone(true)
    // Import massal adalah create-flow terbesar di aplikasi ini — tanpa invalidasi,
    // Daftar Tamu tetap menampilkan jumlah lama sampai operator ganti filter.
    // AUDIT_2026-08-01 #19.
    if (success > 0) qc.invalidateQueries({ queryKey: ['guests'] })
    if (success > 0) toast.success(`${success} tamu berhasil diimport`)
    if (failed > 0) toast.error(`${failed} tamu gagal diimport`)
  }

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => navigate('/admin/guests')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="admin-h1">Import Tamu dari CSV</h1>
          <p className="admin-subtitle">Upload file CSV untuk menambah tamu secara bulk</p>
        </div>
      </div>

      {/* Upload area */}
      <div className="admin-card p-6">
        <div
          className="border-2 border-dashed rounded-xl p-8 text-center cursor-pointer hover:border-orange-400 transition-colors"
          onClick={() => fileRef.current?.click()}
        >
          <Upload className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
          <p className="text-sm font-medium">{fileName || 'Klik untuk pilih file CSV'}</p>
          <p className="text-xs text-muted-foreground mt-1">Format: nama, email, notel, jeniskelamin, pendidikan, pekerjaan, kategori_instansi, nama_instansi</p>
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleFile} />
        </div>
      </div>

      {/* Preview */}
      {rows.length > 0 && !done && (
        <div className="admin-card p-5">
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm font-semibold flex items-center gap-2">
              <FileText className="w-4 h-4" />
              Preview: {rows.length} baris
            </p>
            <Button className="bg-orange-600 hover:bg-orange-700 text-white" onClick={handleImport} disabled={importing}>
              {importing ? `Mengimport... (${results.success + results.failed}/${rows.length})` : `Import ${rows.length} Tamu`}
            </Button>
          </div>
          <div className="rounded-md border overflow-x-auto max-h-60 overflow-y-auto">
            <table className="w-full text-xs">
              <thead><tr className="bg-muted/50">
                {Object.keys(rows[0]).slice(0, 6).map(k => <th key={k} className="px-3 py-2 text-left font-medium uppercase">{k}</th>)}
              </tr></thead>
              <tbody>
                {rows.slice(0, 20).map((r, i) => (
                  <tr key={i} className="border-t">
                    {Object.values(r).slice(0, 6).map((v, j) => <td key={j} className="px-3 py-1.5">{v}</td>)}
                  </tr>
                ))}
                {rows.length > 20 && <tr><td colSpan={6} className="text-center py-2 text-muted-foreground">... dan {rows.length - 20} baris lainnya</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Results */}
      {done && (
        <div className="admin-card p-6 text-center">
          {results.failed === 0 ? (
            <>
              <CheckCircle className="w-12 h-12 text-green-500 mx-auto mb-3" />
              <p className="text-lg font-bold">Import Berhasil!</p>
              <p className="text-sm text-muted-foreground">{results.success} tamu berhasil ditambahkan</p>
            </>
          ) : (
            <>
              <AlertCircle className="w-12 h-12 text-amber-500 mx-auto mb-3" />
              <p className="text-lg font-bold">Import Selesai</p>
              <p className="text-sm text-muted-foreground">{results.success} berhasil, {results.failed} gagal</p>
            </>
          )}
          <div className="flex gap-3 justify-center mt-4">
            <Button variant="outline" onClick={() => { setRows([]); setDone(false); setFileName('') }}>Import Lagi</Button>
            <Button className="bg-orange-600 hover:bg-orange-700 text-white" onClick={() => navigate('/admin/guests')}>Lihat Daftar Tamu</Button>
          </div>
        </div>
      )}
    </div>
  )
}
