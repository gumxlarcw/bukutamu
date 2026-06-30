import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { toast } from 'sonner'
import { usersApi, type AdminUser } from '@/api/users'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { UserPlus, Pencil, Trash2, Shield, Key } from 'lucide-react'

// Daftar role lengkap (harus mirror backend Users.php $valid_roles + Api_base.php $role_level).
// Diurutkan dari tertinggi (akses paling luas) ke terendah (paling sempit).
const ROLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'superadmin', label: 'Super Admin' },
  { value: 'admin', label: 'Admin' },
  { value: 'pimpinan', label: 'Pimpinan (Viewer)' },
  { value: 'operator', label: 'Operator (Legacy, full access)' },
  { value: 'petugas_pst', label: 'Petugas PST' },
  { value: 'resepsionis', label: 'Resepsionis' },
  { value: 'verifikator', label: 'Verifikator' },
]
const ROLE_LABELS: Record<string, string> = Object.fromEntries(ROLE_OPTIONS.map(r => [r.value, r.label]))
const ROLE_COLORS: Record<string, string> = {
  superadmin:  'bg-red-100 text-red-700',
  admin:       'bg-blue-100 text-blue-700',
  pimpinan:    'bg-purple-100 text-purple-700',
  operator:    'bg-gray-100 text-gray-700',
  petugas_pst: 'bg-orange-100 text-orange-700',
  resepsionis: 'bg-teal-100 text-teal-700',
  verifikator: 'bg-green-100 text-green-700',
}

// Mirror of the backend password rule (Users.php: minimal 8 karakter, harus mengandung
// huruf DAN angka). Enforced client-side only for instant feedback — the BE check stays the
// source of truth. Keep both in sync (lihat feedback_backend_parity).
const isPasswordValid = (pw: string) => pw.length >= 8 && /[A-Za-z]/.test(pw) && /[0-9]/.test(pw)

export default function UserManagementPage() {
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [editUser, setEditUser] = useState<AdminUser | null>(null)
  const [deleteId, setDeleteId] = useState<number | null>(null)
  const [pwOpen, setPwOpen] = useState(false)

  const [form, setForm] = useState({ username: '', password: '', nama: '', notel: '', role: 'operator' })
  const [editForm, setEditForm] = useState({ nama: '', notel: '', role: '', password: '', active: true })
  const [pwForm, setPwForm] = useState({ old_password: '', new_password: '' })

  const { data, isLoading } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => usersApi.list().then(r => r.data.data),
  })

  const createMut = useMutation({
    mutationFn: () => usersApi.create(form),
    onSuccess: () => { toast.success('User berhasil dibuat'); setCreateOpen(false); setForm({ username: '', password: '', nama: '', notel: '', role: 'operator' }); queryClient.invalidateQueries({ queryKey: ['admin-users'] }) },
    onError: (e: unknown) => toast.error((axios.isAxiosError(e) ? e.response?.data?.message : null) || 'Gagal membuat user'),
  })

  const updateMut = useMutation({
    mutationFn: () => usersApi.update(editUser!.id, editForm),
    onSuccess: () => { toast.success('User berhasil diupdate'); setEditUser(null); queryClient.invalidateQueries({ queryKey: ['admin-users'] }) },
    onError: (e: unknown) => toast.error((axios.isAxiosError(e) ? e.response?.data?.message : null) || 'Gagal update'),
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => usersApi.delete(id),
    onSuccess: () => { toast.success('User dihapus'); setDeleteId(null); queryClient.invalidateQueries({ queryKey: ['admin-users'] }) },
    onError: (e: unknown) => toast.error((axios.isAxiosError(e) ? e.response?.data?.message : null) || 'Gagal menghapus'),
  })

  const pwMut = useMutation({
    mutationFn: () => usersApi.changePassword(pwForm),
    onSuccess: () => { toast.success('Password berhasil diubah'); setPwOpen(false); setPwForm({ old_password: '', new_password: '' }) },
    onError: (e: unknown) => toast.error((axios.isAxiosError(e) ? e.response?.data?.message : null) || 'Gagal mengubah password'),
  })

  // Gate "Buat User": username + nama wajib terisi dan password lolos aturan BE.
  const createPasswordError = form.password.length > 0 && !isPasswordValid(form.password)
  const createFormValid = form.username.trim() !== '' && form.nama.trim() !== '' && isPasswordValid(form.password)

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="admin-h1">Manajemen User</h1>
          <p className="admin-subtitle">Kelola akun admin dan operator</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setPwOpen(true)}>
            <Key className="w-4 h-4 mr-2" />
            Ganti Password
          </Button>
          <Button className="bg-orange-600 hover:bg-orange-700 text-white" onClick={() => setCreateOpen(true)}>
            <UserPlus className="w-4 h-4 mr-2" />
            Tambah User
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-md" />)}</div>
      ) : (
        <div className="space-y-2">
          {(data ?? []).map(u => (
            <div key={u.id} className="admin-card flex items-center gap-4 p-4">
              <div className="w-10 h-10 rounded-full bg-orange-100 flex items-center justify-center shrink-0">
                <Shield className="w-5 h-5 text-orange-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm">{u.nama} <span className="text-muted-foreground font-normal">@{u.username}</span></p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${ROLE_COLORS[u.role]}`}>{ROLE_LABELS[u.role]}</span>
                  {!u.active && <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-100 text-red-600">Nonaktif</span>}
                  {u.last_login && <span className="text-xs text-muted-foreground">Login terakhir: {new Date(u.last_login).toLocaleDateString('id-ID')}</span>}
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button size="sm" variant="outline" onClick={() => { setEditUser(u); setEditForm({ nama: u.nama, notel: u.notel ?? '', role: u.role, password: '', active: !!u.active }) }}>
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
                <Button size="sm" variant="outline" className="text-red-600 hover:text-red-700 hover:bg-red-50" onClick={() => setDeleteId(u.id)}>
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Tambah User Baru</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1"><Label>Username</Label><Input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} /></div>
            <div className="space-y-1"><Label>Nama Lengkap</Label><Input value={form.nama} onChange={e => setForm(f => ({ ...f, nama: e.target.value }))} /></div>
            <div className="space-y-1"><Label>No. WhatsApp</Label><Input value={form.notel} onChange={e => setForm(f => ({ ...f, notel: e.target.value }))} placeholder="62812xxxxxxx" /></div>
            <div className="space-y-1">
              <Label>Password</Label>
              <Input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder="Min 8 karakter, huruf + angka" aria-invalid={createPasswordError ? true : undefined} />
              {createPasswordError && <p className="text-red-600 text-xs">Password minimal 8 karakter, harus mengandung huruf dan angka</p>}
            </div>
            <div className="space-y-1">
              <Label>Role</Label>
              <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))} className="w-full border rounded px-3 py-2 text-sm bg-background">
                {ROLE_OPTIONS.map(r => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Batal</Button>
            <Button className="bg-orange-600 hover:bg-orange-700 text-white" onClick={() => createMut.mutate()} disabled={createMut.isPending || !createFormValid}>
              {createMut.isPending ? 'Membuat...' : 'Buat User'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editUser} onOpenChange={open => !open && setEditUser(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Edit User</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1"><Label>Nama Lengkap</Label><Input value={editForm.nama} onChange={e => setEditForm(f => ({ ...f, nama: e.target.value }))} /></div>
            <div className="space-y-1"><Label>No. WhatsApp</Label><Input value={editForm.notel} onChange={e => setEditForm(f => ({ ...f, notel: e.target.value }))} placeholder="62812xxxxxxx" /></div>
            <div className="space-y-1">
              <Label>Role</Label>
              <select value={editForm.role} onChange={e => setEditForm(f => ({ ...f, role: e.target.value }))} className="w-full border rounded px-3 py-2 text-sm bg-background">
                {ROLE_OPTIONS.map(r => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1"><Label>Password Baru (kosongkan jika tidak ubah)</Label><Input type="password" value={editForm.password} onChange={e => setEditForm(f => ({ ...f, password: e.target.value }))} /></div>
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={editForm.active} onChange={e => setEditForm(f => ({ ...f, active: e.target.checked }))} id="active-check" />
              <Label htmlFor="active-check">Aktif</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditUser(null)}>Batal</Button>
            <Button className="bg-orange-600 hover:bg-orange-700 text-white" onClick={() => updateMut.mutate()} disabled={updateMut.isPending}>Simpan</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete dialog */}
      <Dialog open={deleteId !== null} onOpenChange={open => !open && setDeleteId(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Hapus User</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground py-2">Yakin ingin menghapus user ini?</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>Batal</Button>
            <Button variant="destructive" onClick={() => deleteId && deleteMut.mutate(deleteId)} disabled={deleteMut.isPending}>Hapus</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Change password dialog */}
      <Dialog open={pwOpen} onOpenChange={setPwOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Ganti Password</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1"><Label>Password Lama</Label><Input type="password" value={pwForm.old_password} onChange={e => setPwForm(f => ({ ...f, old_password: e.target.value }))} /></div>
            <div className="space-y-1"><Label>Password Baru</Label><Input type="password" value={pwForm.new_password} onChange={e => setPwForm(f => ({ ...f, new_password: e.target.value }))} placeholder="Min 8 karakter, huruf + angka" /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPwOpen(false)}>Batal</Button>
            <Button className="bg-orange-600 hover:bg-orange-700 text-white" onClick={() => pwMut.mutate()} disabled={pwMut.isPending}>
              {pwMut.isPending ? 'Menyimpan...' : 'Ubah Password'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
