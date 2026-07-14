import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { guestsApi, type GuestVisit } from '@/api/guests'
import type { Guest } from '@/types/guest'
import {
  PENDIDIKAN_OPTIONS,
  UMUR_OPTIONS,
  DISABILITAS_OPTIONS,
  JENIS_DISABILITAS_OPTIONS,
  PEKERJAAN_OPTIONS,
  KATEGORI_INSTANSI_OPTIONS,
  PEMANFAATAN_OPTIONS,
} from '@/types/guest'
import { GuestTable } from '@/components/admin/GuestTable'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Search, UserPlus, ChevronLeft, ChevronRight, Download, Clock, Pencil } from 'lucide-react'
import { useAuth } from '@/providers/AuthProvider'
import { parseLayanan } from '@/types/visit'
import { exportCsv } from '@/lib/export-csv'

export default function GuestListPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const canDelete = user?.role === 'superadmin' || user?.role === 'admin'

  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(10)
  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput)
      setPage(1)
    }, 400)
    return () => clearTimeout(t)
  }, [searchInput])

  const { data, isLoading } = useQuery({
    queryKey: ['guests', { search, page, limit }],
    queryFn: () => guestsApi.list({ search, page, limit }).then(r => r.data),
  })

  const guests = data?.data ?? []
  const pagination = data?.pagination

  // Edit dialog state
  const [viewGuest, setViewGuest] = useState<Guest | null>(null)
  const [editGuest, setEditGuest] = useState<Guest | null>(null)
  const [editForm, setEditForm] = useState<Partial<Guest>>({})

  const openEdit = useCallback((guest: Guest) => {
    setEditGuest(guest)
    setEditForm({
      nama: guest.nama,
      email: guest.email,
      notel: guest.notel,
      jeniskelamin: guest.jeniskelamin,
      umur: guest.umur,
      disabilitas: Number(guest.disabilitas), // #37 CI3 numeric-string coercion (used in === 1 check)
      jenis_disabilitas: Number(guest.jenis_disabilitas),
      pendidikan: guest.pendidikan,
      pekerjaan: guest.pekerjaan,
      kategori_instansi: guest.kategori_instansi,
      nama_instansi: guest.nama_instansi,
      pemanfaatan: guest.pemanfaatan,
    })
  }, [])

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Guest> }) =>
      guestsApi.update(id, data),
    onSuccess: () => {
      toast.success('Data tamu berhasil diperbarui')
      setEditGuest(null)
      queryClient.invalidateQueries({ queryKey: ['guests'] })
    },
    onError: () => toast.error('Gagal memperbarui data tamu'),
  })

  // Delete confirmation
  const [deleteId, setDeleteId] = useState<number | null>(null)

  const deleteMutation = useMutation({
    mutationFn: (id: number) => guestsApi.delete(id),
    onSuccess: () => {
      toast.success('Tamu berhasil dihapus')
      setDeleteId(null)
      queryClient.invalidateQueries({ queryKey: ['guests'] })
    },
    // Surface the backend message (e.g. 409 "tamu masih punya N kunjungan, hapus
    // kunjungannya dulu") so the operator knows the actionable reason, not just "gagal".
    onError: (err: unknown) => {
      const msg = (err && typeof err === 'object' && 'response' in err)
        ? (err as { response?: { data?: { message?: string } } }).response?.data?.message
        : null
      toast.error(msg || 'Gagal menghapus tamu')
    },
  })

  const { data: visitHistory } = useQuery({
    queryKey: ['guest-visits', editGuest?.id_user],
    queryFn: () => guestsApi.getVisits(editGuest!.id_user).then(r => r.data.data),
    enabled: !!editGuest,
  })

  const { data: viewVisitHistory } = useQuery({
    queryKey: ['guest-visits', viewGuest?.id_user],
    queryFn: () => guestsApi.getVisits(viewGuest!.id_user).then(r => r.data.data),
    enabled: !!viewGuest,
  })

  const handleSaveEdit = () => {
    if (!editGuest) return
    updateMutation.mutate({ id: editGuest.id_user, data: editForm })
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="admin-h1">Daftar Tamu</h1>
          <p className="admin-subtitle">Kelola data pengunjung PST</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              guestsApi.list({ limit: 10000 }).then(r => {
                exportCsv('daftar-tamu', r.data.data.map(g => ({
                  id_user: g.id_user,
                  nama: g.nama,
                  email: g.email,
                  telepon: g.notel,
                  jenis_kelamin: g.jeniskelamin,
                  umur: UMUR_OPTIONS.find(o => o.value === Number(g.umur))?.label ?? '',
                  pendidikan: PENDIDIKAN_OPTIONS.find(o => o.value === Number(g.pendidikan))?.label ?? '',
                  pekerjaan: PEKERJAAN_OPTIONS.find(o => o.value === Number(g.pekerjaan))?.label ?? '',
                  pekerjaan_lainnya: g.pekerjaan_lainnya ?? '',
                  kategori_instansi: KATEGORI_INSTANSI_OPTIONS.find(o => o.value === Number(g.kategori_instansi))?.label ?? '',
                  kategori_lainnya: g.kategori_lainnya ?? '',
                  nama_instansi: g.nama_instansi,
                  pemanfaatan: PEMANFAATAN_OPTIONS.find(o => o.value === Number(g.pemanfaatan))?.label ?? '',
                  pemanfaatan_lainnya: g.pemanfaatan_lainnya ?? '',
                  disabilitas: DISABILITAS_OPTIONS.find(o => o.value === Number(g.disabilitas))?.label ?? '',
                  jenis_disabilitas: Number(g.disabilitas) === 1 ? (JENIS_DISABILITAS_OPTIONS.find(o => o.value === Number(g.jenis_disabilitas))?.label ?? '') : '',
                  pengaduan: g.pengaduan ?? '',
                  tgl_daftar: g.tgldatang,
                  sumber: g.registered_via ?? '',
                })))
              })
            }}
          >
            <Download className="w-4 h-4 mr-2" />
            Export CSV
          </Button>
          <Button variant="outline" onClick={() => navigate('/admin/guests/import')}>
            <Download className="w-4 h-4 mr-2" />
            Import CSV
          </Button>
          <Button
            className="bg-orange-600 hover:bg-orange-700 text-white"
            onClick={() => navigate('/admin/guests/add')}
          >
            <UserPlus className="w-4 h-4 mr-2" />
            Tambah Tamu
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1 min-w-[200px]">
          <Label htmlFor="guest-search">Cari</Label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input id="guest-search" placeholder="Nama, email, instansi..." value={searchInput} onChange={e => setSearchInput(e.target.value)} className="pl-9" />
          </div>
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 rounded-md" />
          ))}
        </div>
      ) : (
        <GuestTable guests={guests} onView={setViewGuest} onEdit={openEdit} onDelete={setDeleteId} canDelete={canDelete} />
      )}

      {/* Pagination */}
      {pagination && (
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>Tampilkan</span>
            <select
              value={limit}
              onChange={e => { setLimit(Number(e.target.value)); setPage(1) }}
              className="border rounded px-2 py-1 text-sm bg-background"
            >
              {[10, 25, 50, 100].map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <span>per halaman</span>
            <span className="ml-2">
              Total: <strong>{pagination.total}</strong>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(p => p - 1)}
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className="text-sm">
              {page} / {pagination.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pagination.totalPages}
              onClick={() => setPage(p => p + 1)}
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Edit dialog */}
      <Dialog open={!!editGuest} onOpenChange={open => !open && setEditGuest(null)}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Data Tamu</DialogTitle>
          </DialogHeader>
          {/* Photo */}
          {editGuest && (
            <div className="flex justify-center py-2">
              <img
                src={`/api/guests/${editGuest.id_user}/photo`}
                alt=""
                className="w-20 h-20 rounded-full object-cover border-2 border-[--admin-border-strong]"
                onError={e => { e.currentTarget.style.display = 'none' }}
              />
            </div>
          )}
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label>Nama</Label>
              <Input
                value={editForm.nama ?? ''}
                onChange={e => setEditForm(f => ({ ...f, nama: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Email</Label>
              <Input
                type="email"
                value={editForm.email ?? ''}
                onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>No. Telepon</Label>
              <Input
                value={editForm.notel ?? ''}
                onChange={e => setEditForm(f => ({ ...f, notel: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Jenis Kelamin</Label>
              <select
                value={editForm.jeniskelamin ?? ''}
                onChange={e => setEditForm(f => ({ ...f, jeniskelamin: e.target.value as 'Laki-laki' | 'Perempuan' }))}
                className="w-full border rounded px-3 py-2 text-sm bg-background"
              >
                <option value="Laki-laki">Laki-laki</option>
                <option value="Perempuan">Perempuan</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label>Umur</Label>
              <select value={editForm.umur ?? ''} onChange={e => setEditForm(f => ({ ...f, umur: Number(e.target.value) }))} className="w-full border rounded px-3 py-2 text-sm bg-background">
                <option value="">-- Pilih --</option>
                {UMUR_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label>Disabilitas</Label>
              <select value={editForm.disabilitas ?? ''} onChange={e => setEditForm(f => ({ ...f, disabilitas: Number(e.target.value), jenis_disabilitas: Number(e.target.value) !== 1 ? 0 : f.jenis_disabilitas }))} className="w-full border rounded px-3 py-2 text-sm bg-background">
                <option value="">-- Pilih --</option>
                {DISABILITAS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            {editForm.disabilitas === 1 && (
              <div className="space-y-1">
                <Label>Jenis Disabilitas</Label>
                <select value={editForm.jenis_disabilitas ?? ''} onChange={e => setEditForm(f => ({ ...f, jenis_disabilitas: Number(e.target.value) }))} className="w-full border rounded px-3 py-2 text-sm bg-background">
                  <option value="">-- Pilih --</option>
                  {JENIS_DISABILITAS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
            )}
            <div className="space-y-1">
              <Label>Pendidikan</Label>
              <select
                value={editForm.pendidikan ?? ''}
                onChange={e => setEditForm(f => ({ ...f, pendidikan: Number(e.target.value) }))}
                className="w-full border rounded px-3 py-2 text-sm bg-background"
              >
                {PENDIDIKAN_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>Pekerjaan</Label>
              <select
                value={editForm.pekerjaan ?? ''}
                onChange={e => setEditForm(f => ({ ...f, pekerjaan: Number(e.target.value) }))}
                className="w-full border rounded px-3 py-2 text-sm bg-background"
              >
                {PEKERJAAN_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>Kategori Instansi</Label>
              <select
                value={editForm.kategori_instansi ?? ''}
                onChange={e => setEditForm(f => ({ ...f, kategori_instansi: Number(e.target.value) }))}
                className="w-full border rounded px-3 py-2 text-sm bg-background"
              >
                {KATEGORI_INSTANSI_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>Nama Instansi</Label>
              <Input
                value={editForm.nama_instansi ?? ''}
                onChange={e => setEditForm(f => ({ ...f, nama_instansi: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Pemanfaatan</Label>
              <select value={editForm.pemanfaatan ?? ''} onChange={e => setEditForm(f => ({ ...f, pemanfaatan: Number(e.target.value) }))} className="w-full border rounded px-3 py-2 text-sm bg-background">
                <option value="">-- Pilih --</option>
                {PEMANFAATAN_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>

          {/* Visit history */}
          {visitHistory && visitHistory.length > 0 && (
            <div className="border-t pt-3 mt-3">
              <p className="text-sm font-semibold flex items-center gap-1.5 mb-2">
                <Clock className="w-4 h-4" />
                Riwayat Kunjungan ({visitHistory.length})
              </p>
              <div className="max-h-40 overflow-y-auto space-y-1.5">
                {visitHistory.map((v: GuestVisit) => (
                  <div key={v.id_kunjungan} className="flex items-center gap-2 text-xs p-2 rounded-lg bg-muted/40">
                    <span className="text-muted-foreground shrink-0">
                      {new Date(v.date_visit).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </span>
                    <div className="flex flex-wrap gap-1 flex-1 min-w-0">
                      {parseLayanan(v.jenis_layanan).map((l, i) => (
                        <span key={i} className="px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 text-[10px]">{l}</span>
                      ))}
                    </div>
                    <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${v.status === 'selesai' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                      {v.status}
                    </span>
                    {v.rating_pengunjung && <span className="text-amber-600 font-bold">★{v.rating_pengunjung}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditGuest(null)}>
              Batal
            </Button>
            <Button
              className="bg-orange-600 hover:bg-orange-700 text-white"
              onClick={handleSaveEdit}
              disabled={updateMutation.isPending}
            >
              {updateMutation.isPending ? 'Menyimpan...' : 'Simpan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={deleteId !== null} onOpenChange={open => !open && setDeleteId(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Konfirmasi Hapus</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            Apakah Anda yakin ingin menghapus tamu ini? Tindakan ini tidak dapat dibatalkan.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>
              Batal
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteId !== null && deleteMutation.mutate(deleteId)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Menghapus...' : 'Hapus'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View detail dialog */}
      <Dialog open={!!viewGuest} onOpenChange={open => !open && setViewGuest(null)}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Detail Tamu</DialogTitle>
          </DialogHeader>
          {viewGuest && (
            <div className="space-y-4 py-2">
              {/* Photo + name */}
              <div className="flex items-center gap-4">
                <img
                  src={`/api/guests/${viewGuest.id_user}/photo`}
                  alt=""
                  className="w-16 h-16 rounded-full object-cover border-2 border-[--admin-border-strong] shrink-0"
                  onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                />
                <div>
                  <p className="text-lg font-bold">{viewGuest.nama}</p>
                  <p className="text-sm text-muted-foreground">ID: {viewGuest.id_user}</p>
                </div>
              </div>

              {/* Data grid */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <DetailField label="Email" value={viewGuest.email} />
                <DetailField label="Telepon" value={viewGuest.notel} />
                <DetailField label="Jenis Kelamin" value={viewGuest.jeniskelamin} />
                <DetailField label="Umur" value={UMUR_OPTIONS.find(o => o.value === Number(viewGuest.umur))?.label ?? '-'} />
                <DetailField label="Pendidikan" value={PENDIDIKAN_OPTIONS.find(o => o.value === Number(viewGuest.pendidikan))?.label ?? '-'} />
                <DetailField label="Pekerjaan" value={PEKERJAAN_OPTIONS.find(o => o.value === Number(viewGuest.pekerjaan))?.label ?? '-'} />
                <DetailField label="Kategori Instansi" value={KATEGORI_INSTANSI_OPTIONS.find(o => o.value === Number(viewGuest.kategori_instansi))?.label ?? '-'} />
                <DetailField label="Nama Instansi" value={viewGuest.nama_instansi || '-'} />
                <DetailField label="Pemanfaatan" value={PEMANFAATAN_OPTIONS.find(o => o.value === Number(viewGuest.pemanfaatan))?.label ?? '-'} />
                <DetailField label="Disabilitas" value={DISABILITAS_OPTIONS.find(o => o.value === Number(viewGuest.disabilitas))?.label ?? '-'} />
                {Number(viewGuest.disabilitas) === 1 && (
                  <DetailField label="Jenis Disabilitas" value={JENIS_DISABILITAS_OPTIONS.find(o => o.value === Number(viewGuest.jenis_disabilitas))?.label ?? '-'} />
                )}
                <DetailField label="Tgl Datang" value={viewGuest.tgldatang || '-'} />
                <DetailField label="Sumber" value={viewGuest.registered_via === 'kiosk' ? 'Kiosk' : viewGuest.registered_via?.startsWith('admin:') ? `Admin (${viewGuest.registered_via?.replace('admin:', '')})` : '-'} />
              </div>

              {/* Visit history */}
              {viewVisitHistory && viewVisitHistory.length > 0 && (
                <div className="border-t pt-3">
                  <p className="text-sm font-semibold flex items-center gap-1.5 mb-2">
                    <Clock className="w-4 h-4" />
                    Riwayat Kunjungan ({viewVisitHistory.length})
                  </p>
                  <div className="max-h-48 overflow-y-auto space-y-1.5">
                    {viewVisitHistory.map((v: GuestVisit) => (
                      <div key={v.id_kunjungan} className="flex items-center gap-2 text-xs p-2 rounded-lg bg-muted/40">
                        <span className="text-muted-foreground shrink-0">
                          {new Date(v.date_visit).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })}
                        </span>
                        <div className="flex flex-wrap gap-1 flex-1 min-w-0">
                          {parseLayanan(v.jenis_layanan).map((l, i) => (
                            <span key={i} className="px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 text-[10px]">{l}</span>
                          ))}
                        </div>
                        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${v.status === 'selesai' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                          {v.status}
                        </span>
                        {v.rating_pengunjung && <span className="text-amber-600 font-bold">★{v.rating_pengunjung}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewGuest(null)}>Tutup</Button>
            <Button className="bg-orange-600 hover:bg-orange-700 text-white" onClick={() => { if (viewGuest) { openEdit(viewGuest); setViewGuest(null) } }}>
              <Pencil className="w-4 h-4 mr-2" />
              Edit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function DetailField({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  )
}
