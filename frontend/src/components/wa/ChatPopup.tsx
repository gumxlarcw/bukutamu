import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Send, Paperclip, X, Minus, FileText, Clock, Check, CheckCheck,
  AlertCircle, MessageCircle, Download,
} from 'lucide-react'
import { waApi } from '@/api/wa'
import type { WaMessage } from '@/types/wa'

const ALLOWED_MIME = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]
const MAX_BYTES = 25 * 1024 * 1024

function timeOf(iso: string): string {
  const d = new Date((iso || '').replace(' ', 'T'))
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
}
function errMsg(e: unknown): string | null {
  if (e && typeof e === 'object' && 'response' in e) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (e as any).response?.data?.message ?? null
  }
  return null
}

/** Status tick di sudut bubble keluar — mengikuti perjalanan kirim WhatsApp. */
function StatusTick({ status }: { status: WaMessage['status'] }) {
  if (status === 'pending') return <Clock className="w-3 h-3 opacity-60" aria-label="menunggu kirim" />
  if (status === 'sent') return <CheckCheck className="w-3.5 h-3.5 opacity-70" aria-label="terkirim" />
  if (status === 'failed') return <AlertCircle className="w-3.5 h-3.5 text-red-500" aria-label="gagal" />
  return <Check className="w-3 h-3 opacity-50" />
}

/** Cincin progress (circular) saat mengunggah file. */
function Ring({ pct }: { pct: number }) {
  const r = 10, circ = 2 * Math.PI * r
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" className="shrink-0" aria-label={`mengunggah ${pct}%`}>
      <circle cx="12" cy="12" r={r} fill="none" stroke="rgba(120,90,60,.25)" strokeWidth="2.5" />
      <circle
        cx="12" cy="12" r={r} fill="none" stroke="var(--admin-primary)" strokeWidth="2.5"
        strokeDasharray={circ} strokeDashoffset={circ - (pct / 100) * circ} strokeLinecap="round"
        transform="rotate(-90 12 12)" style={{ transition: 'stroke-dashoffset .2s ease' }}
      />
    </svg>
  )
}

interface ChatPopupProps {
  phone: string
  nama: string | null
  index?: number
  onClose: () => void
}

export function ChatPopup({ phone, nama, index = 0, onClose }: ChatPopupProps) {
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [min, setMin] = useState(false)
  const [shown, setShown] = useState(false)
  const [drag, setDrag] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState<{ pct: number; name: string; preview: string | null; isImage: boolean } | null>(null)
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const endRef = useRef<HTMLDivElement>(null)

  const { data: messages = [], isLoading } = useQuery({
    queryKey: ['wa-chat', phone],
    queryFn: () => waApi.getMessages(phone).then((r) => r.data.data),
    refetchInterval: 4000,
    gcTime: 0, // jangan simpan cache thread setelah popup ditutup
  })

  const send = useMutation({
    mutationFn: (body: string) => waApi.sendText(phone, body),
    onSuccess: () => { setText(''); qc.invalidateQueries({ queryKey: ['wa-chat', phone] }) },
    onError: (e) => toast.error(errMsg(e) || 'Gagal mengirim pesan'),
  })
  const clearUploading = () => setUploading((u) => { if (u?.preview) URL.revokeObjectURL(u.preview); return null })
  const upload = useMutation({
    mutationFn: (file: File) =>
      waApi.uploadFile(phone, file, text.trim() || undefined, (pct) => setUploading((u) => (u ? { ...u, pct } : u))),
    onSuccess: () => { setText(''); clearUploading(); qc.invalidateQueries({ queryKey: ['wa-chat', phone] }) },
    onError: (e) => { clearUploading(); toast.error(errMsg(e) || 'Gagal mengirim file') },
  })

  useEffect(() => { const r = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(r) }, [])
  // Saat popup dibuka, minta backfill histori chat (idempoten + throttled di backend).
  // Polling getMessages akan memunculkan pesan histori beberapa detik kemudian.
  useEffect(() => { waApi.requestBackfill(phone).catch(() => { /* best-effort */ }) }, [phone])
  // Auto-scroll ke bawah saat ada pesan baru / popup dibuka.
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages.length, min, uploading?.name])
  // Textarea auto-grow (maks ~5 baris).
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'
  }, [text])

  const initial = useMemo(() => (nama || phone || '?').trim().charAt(0).toUpperCase(), [nama, phone])
  const busy = send.isPending || upload.isPending

  function submitText() {
    const b = text.trim()
    if (!b || busy) return
    if (b.length > 4096) { toast.error('Pesan maksimal 4096 karakter'); return }
    send.mutate(b)
  }
  function pickFile(file: File | undefined) {
    if (!file || upload.isPending) return
    if (file.size > MAX_BYTES) { toast.error('Ukuran file melebihi 25 MB'); return }
    if (!ALLOWED_MIME.includes(file.type)) { toast.error('Tipe file tidak didukung (gambar / pdf / doc / xls)'); return }
    const isImage = file.type.startsWith('image/')
    setUploading({ pct: 0, name: file.name, preview: isImage ? URL.createObjectURL(file) : null, isImage })
    upload.mutate(file)
  }
  // Tempel (Ctrl+V) gambar dari clipboard → langsung kirim.
  function onPaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items
    if (!items) return
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile()
        if (f) { e.preventDefault(); pickFile(f); return }
      }
    }
  }

  // ── Drag dari header ──
  function onDown(e: React.PointerEvent) {
    if ((e.target as HTMLElement).closest('button')) return
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: drag.x, oy: drag.y }
    setDragging(true)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  function onMove(e: React.PointerEvent) {
    const d = dragRef.current
    if (!d) return
    setDrag({ x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) })
  }
  function onUp(e: React.PointerEvent) {
    dragRef.current = null
    setDragging(false)
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* noop */ }
  }

  // Portal ke <body>: lepas dari ancestor ber-transform (.admin-enter) supaya position:fixed
  // diukur dari VIEWPORT, bukan kotak konten. .admin-shell bukan stacking context, jadi nav
  // (z-40) ada di level root → popup z-30 di body otomatis berada DI BAWAH nav.
  return createPortal(
    <div
      className="fixed z-30"
      style={{ right: `${16 + index * 26}px`, bottom: `${16 + index * 26}px`, transform: `translate(${drag.x}px, ${drag.y}px)` }}
    >
      <div
        className="w-[360px] max-w-[calc(100vw-2rem)] rounded-2xl overflow-hidden flex flex-col"
        style={{
          opacity: shown ? 1 : 0,
          transform: shown ? 'translateY(0) scale(1)' : 'translateY(10px) scale(.98)',
          transition: 'opacity .22s ease, transform .22s cubic-bezier(.2,.8,.2,1)',
          height: min ? 'auto' : '520px',
          // Selalu di bawah top nav (56px) — beri jarak nav + gap atas/bawah agar tepi atas
          // popup tak pernah masuk ke belakang nav, di ukuran layar mana pun.
          maxHeight: 'calc(100vh - 88px)',
          background: 'var(--admin-bg, #fff)',
          border: '1px solid var(--admin-border)',
          boxShadow: dragging ? '0 24px 60px -12px rgba(80,50,20,.45)' : '0 18px 44px -16px rgba(80,50,20,.38)',
        }}
      >
        {/* ── Header (drag handle) ── */}
        <div
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          className="flex items-center gap-2.5 px-3.5 py-2.5 cursor-grab active:cursor-grabbing touch-none select-none"
          style={{ background: 'linear-gradient(135deg, var(--admin-primary), color-mix(in srgb, var(--admin-primary) 78%, #000))' }}
        >
          <span className="w-9 h-9 rounded-full grid place-items-center text-sm font-bold text-white shrink-0"
            style={{ background: 'rgba(255,255,255,.22)' }}>
            {initial}
          </span>
          <div className="min-w-0 flex-1 text-white">
            <p className="text-sm font-semibold leading-tight truncate">{nama || 'Kontak WhatsApp'}</p>
            <p className="text-[11px] leading-tight flex items-center gap-1 text-white/85">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-300 inline-block" /> {phone} · via WhatsApp
            </p>
          </div>
          <button onClick={() => setMin((v) => !v)} aria-label={min ? 'Buka' : 'Kecilkan'} className="p-1 rounded-md text-white/90 hover:bg-white/15 transition-colors" title={min ? 'Buka' : 'Kecilkan'}>
            <Minus className="w-4 h-4" />
          </button>
          <button onClick={onClose} aria-label="Tutup" className="p-1 rounded-md text-white/90 hover:bg-white/15 transition-colors" title="Tutup">
            <X className="w-4 h-4" />
          </button>
        </div>

        {!min && (
          <>
            {/* ── Canvas pesan (paper-dot texture) ── */}
            <div
              className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5"
              style={{
                backgroundColor: '#f7f2ea',
                backgroundImage: 'radial-gradient(rgba(120,90,60,.06) 1px, transparent 1px)',
                backgroundSize: '15px 15px',
              }}
            >
              {isLoading ? (
                <p className="text-center text-xs mt-6" style={{ color: 'var(--admin-text-muted)' }}>Memuat percakapan…</p>
              ) : messages.length === 0 ? (
                <div className="h-full grid place-items-center text-center px-6">
                  <div>
                    <MessageCircle className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--admin-primary)', opacity: .5 }} />
                    <p className="text-sm font-medium" style={{ color: 'var(--admin-text-secondary)' }}>Belum ada pesan</p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--admin-text-muted)' }}>Mulai percakapan dengan {nama || 'pemohon'}.</p>
                  </div>
                </div>
              ) : (
                messages.map((m) => {
                  const out = m.direction === 'out'
                  return (
                    <div key={m.id} className={`flex ${out ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className="max-w-[78%] px-2.5 py-1.5 text-sm shadow-sm"
                        style={{
                          background: out ? 'var(--admin-primary-light)' : '#fff',
                          color: 'var(--admin-text)',
                          border: out ? '1px solid color-mix(in srgb, var(--admin-primary) 22%, transparent)' : '1px solid var(--admin-border)',
                          borderRadius: out ? '14px 14px 5px 14px' : '14px 14px 14px 5px',
                        }}
                      >
                        {m.msg_type === 'image' && m.media_url && (
                          <a href={m.media_url} target="_blank" rel="noreferrer" className="block mb-1">
                            <img src={m.media_url} alt={m.media_name || 'gambar'} className="rounded-lg max-h-52 w-auto object-cover" loading="lazy" />
                          </a>
                        )}
                        {m.msg_type === 'document' && m.media_url && (
                          <a
                            href={m.media_url}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-2 mb-1 px-2 py-1.5 rounded-lg"
                            style={{ background: out ? 'rgba(255,255,255,.5)' : 'var(--admin-primary-light)' }}
                          >
                            <FileText className="w-5 h-5 shrink-0" style={{ color: 'var(--admin-primary)' }} />
                            <span className="text-xs font-medium truncate max-w-[180px]">{m.media_name || 'dokumen'}</span>
                            <Download className="w-3.5 h-3.5 ml-auto shrink-0 opacity-60" />
                          </a>
                        )}
                        {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
                        <div className="flex items-center gap-1 justify-end mt-0.5" style={{ color: 'var(--admin-text-muted)' }}>
                          <span className="text-[10px]">{timeOf(m.created_at)}</span>
                          {out && <StatusTick status={m.status} />}
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
              {uploading && (
                <div className="flex justify-end">
                  <div
                    className="max-w-[78%] px-2 py-1.5 rounded-2xl"
                    style={{ background: 'var(--admin-primary-light)', border: '1px solid color-mix(in srgb, var(--admin-primary) 22%, transparent)' }}
                  >
                    {uploading.isImage && uploading.preview ? (
                      <div className="relative">
                        <img src={uploading.preview} alt={uploading.name} className="rounded-lg max-h-52 w-auto block opacity-50" />
                        <div className="absolute inset-0 grid place-items-center"><Ring pct={uploading.pct} /></div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 py-0.5">
                        <Ring pct={uploading.pct} />
                        <span className="text-xs truncate max-w-[170px]" style={{ color: 'var(--admin-text)' }}>{uploading.name}</span>
                      </div>
                    )}
                    <p className="text-[10px] text-right mt-0.5" style={{ color: 'var(--admin-text-muted)' }}>Mengirim… {uploading.pct}%</p>
                  </div>
                </div>
              )}
              <div ref={endRef} />
            </div>

            {/* ── Composer ── */}
            <div className="flex items-end gap-1.5 px-2.5 py-2 border-t" style={{ borderColor: 'var(--admin-border)', background: '#fff' }}>
              <input
                ref={fileRef}
                type="file"
                hidden
                accept={ALLOWED_MIME.join(',')}
                onChange={(e) => { pickFile(e.target.files?.[0]); e.currentTarget.value = '' }}
              />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={busy}
                aria-label="Lampirkan gambar atau dokumen"
                className="p-2 rounded-full shrink-0 transition-colors hover:bg-[var(--admin-primary-light)] disabled:opacity-50"
                title="Lampirkan gambar / dokumen (maks 25 MB)"
                style={{ color: 'var(--admin-text-secondary)' }}
              >
                <Paperclip className="w-5 h-5" />
              </button>
              <textarea
                ref={taRef}
                rows={1}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitText() } }}
                onPaste={onPaste}
                placeholder="Ketik pesan… (tempel gambar dengan Ctrl+V)"
                className="flex-1 resize-none px-3 py-2 text-sm rounded-2xl outline-none leading-snug"
                style={{ background: '#f3eee6', color: 'var(--admin-text)', maxHeight: 120 }}
              />
              <button
                onClick={submitText}
                disabled={busy || text.trim() === ''}
                aria-label="Kirim"
                className="p-2.5 rounded-full shrink-0 text-white transition-transform active:scale-90 disabled:opacity-40 disabled:active:scale-100"
                style={{ background: 'var(--admin-primary)' }}
                title="Kirim"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
