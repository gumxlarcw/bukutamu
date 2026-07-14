import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { getApiErrorMessage } from '@/lib/apiError'
import {
  Send, Database, X, Minus, FileText, Clock, Check, CheckCheck,
  AlertCircle, MessageCircle, Download, ChevronDown, Reply, SmilePlus, MapPin, User,
} from 'lucide-react'
import { waApi } from '@/api/wa'
import { deliveriesApi } from '@/api/deliveries'
import { safeHref } from '@/lib/url'
import type { WaMessage } from '@/types/wa'
import type { DataDeliveryDetail, DeliveryStatus } from '@/types/delivery'

const ALLOWED_MIME = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]
const MAX_BYTES = 25 * 1024 * 1024

const DELIVERY_LABEL: Record<DeliveryStatus, { t: string; c: string }> = {
  menunggu_verifikasi: { t: '⏳ Menunggu Verifikasi', c: 'bg-amber-100 text-amber-800' },
  revisi: { t: '✏️ Revisi', c: 'bg-rose-100 text-rose-800' },
  disetujui: { t: '✓ Disetujui', c: 'bg-emerald-100 text-emerald-800' },
  terkirim: { t: '✓ Terkirim', c: 'bg-emerald-100 text-emerald-800' },
  dibatalkan: { t: 'Dibatalkan', c: 'bg-zinc-100 text-zinc-600' },
}

// ── Ukuran popup (resizable, persisted) ──
const DEFAULT_SIZE = { w: 360, h: 520 }
const MIN_W = 300, MIN_H = 360
const SIZE_KEY = 'wa-chat-size' // localStorage: { w, h } — dipakai ulang oleh semua popup chat (preferensi petugas)
const clampW = (w: number) => Math.max(MIN_W, Math.min(w, window.innerWidth - 24))
const clampH = (h: number) => Math.max(MIN_H, Math.min(h, window.innerHeight - 88)) // 88 = clearance top-nav (lihat maxHeight)
const GROUP_GAP = 5 * 60 * 1000 // jeda antar-pesan yang memutus pengelompokan bubble (5 menit)
function loadSize(): { w: number; h: number } {
  try {
    const r = JSON.parse(localStorage.getItem(SIZE_KEY) || '')
    if (r && typeof r.w === 'number' && typeof r.h === 'number') return { w: clampW(r.w), h: clampH(r.h) }
  } catch { /* default */ }
  return { ...DEFAULT_SIZE }
}

function timeOf(iso: string): string {
  const d = new Date((iso || '').replace(' ', 'T'))
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
}
function msOf(iso: string): number {
  const d = new Date((iso || '').replace(' ', 'T'))
  return isNaN(d.getTime()) ? 0 : d.getTime()
}
function dayKey(iso: string): string {
  const d = new Date((iso || '').replace(' ', 'T'))
  return isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}
// Pemisah hari ala WhatsApp: Hari ini / Kemarin / tanggal lengkap.
function dayLabel(iso: string): string {
  const d = new Date((iso || '').replace(' ', 'T'))
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const yest = new Date(); yest.setDate(now.getDate() - 1)
  const k = dayKey(iso)
  if (k === `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`) return 'Hari ini'
  if (k === `${yest.getFullYear()}-${yest.getMonth()}-${yest.getDate()}`) return 'Kemarin'
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })
}
function errMsg(e: unknown): string | null {
  return getApiErrorMessage(e, '') || null
}

// Pesan hanya-emoji (≤ ~12 codepoint) → ditampilkan besar tanpa gelembung, seperti WhatsApp.
function isEmojiOnly(s: string): boolean {
  const t = (s || '').trim()
  if (!t || [...t].length > 12) return false
  // buang emoji + pengubah skin-tone + ZWJ/variation-selector/spasi → kalau habis, murni emoji
  const stripped = t
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\p{Emoji_Modifier}/gu, '')
    .replace(/‍/gu, '') // zero-width joiner (emoji majemuk, mis. 👨‍👩‍👧)
    .replace(/️/gu, '') // variation selector-16
    .replace(/\s/gu, '')
  return stripped === '' && /\p{Extended_Pictographic}/u.test(t)
}

// URL di dalam body → tautan yang bisa diklik (tanpa dependensi tambahan).
const URL_RE = /(https?:\/\/[^\s]+)/g
function linkify(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  URL_RE.lastIndex = 0
  while ((m = URL_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    let url = m[0]
    let tail = ''
    const t = url.match(/[.,!?)\]]+$/) // jangan ikutkan tanda baca penutup di akhir tautan
    if (t) { tail = t[0]; url = url.slice(0, -tail.length) }
    out.push(
      <a key={`${m.index}-${url}`} href={url} target="_blank" rel="noreferrer" className="underline break-all" style={{ color: 'inherit' }}>{url}</a>,
    )
    if (tail) out.push(tail)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** Status tick di sudut bubble keluar — mengikuti perjalanan kirim WhatsApp (status + ack). */
function StatusTick({ status, ack }: { status: WaMessage['status']; ack: number }) {
  if (status === 'pending') return <Clock className="w-3 h-3 opacity-60" aria-label="menunggu kirim" />
  if (status === 'failed') return <AlertCircle className="w-3.5 h-3.5 text-red-500" aria-label="gagal" />
  if (ack >= 3) return <CheckCheck className="w-3.5 h-3.5" style={{ color: '#53bdeb' }} aria-label="dibaca" />  // ✓✓ biru
  if (ack >= 2) return <CheckCheck className="w-3.5 h-3.5 opacity-70" aria-label="sampai" />                    // ✓✓ abu
  if (status === 'sent' || ack >= 1) return <Check className="w-3.5 h-3.5 opacity-70" aria-label="terkirim" /> // ✓ tunggal
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

// Parse nama (FN) dari vCard kontak; URL & deskripsi dari pesan lokasi.
function vcardName(body: string | null): string {
  const m = (body || '').match(/(?:^|\n)FN:(.+)/)
  return m ? m[1].trim() : ''
}
function locationUrl(body: string | null): string {
  return (body || '').match(/https?:\/\/\S+/)?.[0] || '#'
}
function locationDesc(body: string | null): string {
  return (body || '').replace(/https?:\/\/\S+/g, '').trim()
}

const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '🙏', '👏']

// Cuplikan teks utk chip "membalas" di komposer.
function replyPreview(m: WaMessage): string {
  if (m.body) return m.body
  if (m.msg_type === 'image') return '[gambar]'
  if (m.msg_type === 'document') return '[dokumen]'
  return '[pesan]'
}

/** Aksi per-bubble (muncul saat hover): balas + picker reaksi cepat. */
function BubbleActions({ open, onReply, onToggleReact, onPick }: {
  open: boolean; onReply: () => void; onToggleReact: () => void; onPick: (emoji: string) => void
}) {
  return (
    <div className="relative flex items-center gap-0.5 self-center shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
      <button onClick={onReply} className="p-1 rounded-full hover:bg-black/5" title="Balas" aria-label="Balas">
        <Reply className="w-3.5 h-3.5" style={{ color: 'var(--admin-text-muted)' }} />
      </button>
      <button onClick={onToggleReact} className="p-1 rounded-full hover:bg-black/5" title="Beri reaksi" aria-label="Beri reaksi">
        <SmilePlus className="w-3.5 h-3.5" style={{ color: 'var(--admin-text-muted)' }} />
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 flex gap-1 px-2 py-1 rounded-full shadow-md z-20"
          style={{ background: '#fff', border: '1px solid var(--admin-border)' }}>
          {QUICK_EMOJIS.map((e) => (
            <button key={e} onClick={() => onPick(e)} className="text-base leading-none hover:scale-125 transition-transform" title={`Reaksi ${e}`}>{e}</button>
          ))}
        </div>
      )}
    </div>
  )
}

interface ChatPopupProps {
  phone: string
  nama: string | null
  index?: number
  onClose: () => void
  idKunjungan?: number | null  // null/absent = no visit yet; disables Kirim Data
}

export function ChatPopup({ phone, nama, index = 0, onClose, idKunjungan = null }: ChatPopupProps) {
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [min, setMin] = useState(false)
  const [shown, setShown] = useState(false)
  const [drag, setDrag] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [size, setSize] = useState(loadSize)
  const [resizing, setResizing] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [seenId, setSeenId] = useState(0) // id pesan terakhir yang sudah dilihat petugas (di dasar scroll)
  const [replyTo, setReplyTo] = useState<{ id: number; preview: string; out: boolean } | null>(null)
  const [reactFor, setReactFor] = useState<number | null>(null)
  const [kirimDataOpen, setKirimDataOpen] = useState(false)
  const [kdLink, setKdLink] = useState('')
  const [kdNote, setKdNote] = useState('')
  const [kdFile, setKdFile] = useState<File | null>(null)
  const [kdPct, setKdPct] = useState(0)
  const [editingDelivery, setEditingDelivery] = useState<DataDeliveryDetail | null>(null)
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const resizeRef = useRef<{ sx: number; sy: number; sw: number; sh: number; mode: 'w' | 'h' | 'wh' } | null>(null)
  const sizeRef = useRef(size)
  const atBottomRef = useRef(true)
  const kdFileRef = useRef<HTMLInputElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)

  const { data: messages = [], isLoading } = useQuery({
    queryKey: ['wa-chat', phone],
    queryFn: () => waApi.getMessages(phone).then((r) => r.data.data),
    refetchInterval: 4000,
    gcTime: 0, // jangan simpan cache thread setelah popup ditutup
  })

  const send = useMutation({
    mutationFn: (vars: { body: string; quoted?: number }) => waApi.sendText(phone, vars.body, vars.quoted),
    onSuccess: () => { setText(''); setReplyTo(null); qc.invalidateQueries({ queryKey: ['wa-chat', phone] }) },
    onError: (e) => toast.error(errMsg(e) || 'Gagal mengirim pesan'),
  })
  const react = useMutation({
    mutationFn: (vars: { id: number; emoji: string }) => waApi.react(vars.id, vars.emoji),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wa-chat', phone] }),
    onError: (e) => toast.error(errMsg(e) || 'Gagal memberi reaksi'),
  })
  function resetKdForm() { setKdLink(''); setKdNote(''); setKdFile(null); setKdPct(0); setEditingDelivery(null) }
  const createDelivery = useMutation({
    mutationFn: (fd: FormData) => deliveriesApi.create(fd, (pct) => setKdPct(pct)),
    onSuccess: () => { toast.success('Data dikirim untuk verifikasi'); resetKdForm(); setKirimDataOpen(false); qc.invalidateQueries({ queryKey: ['deliveries', idKunjungan] }) },
    onError: (e) => toast.error(errMsg(e) || 'Gagal mengirim data'),
  })
  const resubmitDelivery = useMutation({
    mutationFn: ({ id, fd }: { id: number; fd: FormData }) => deliveriesApi.resubmit(id, fd),
    onSuccess: () => { toast.success('Data dikirim ulang untuk verifikasi'); resetKdForm(); setKirimDataOpen(false); qc.invalidateQueries({ queryKey: ['deliveries', idKunjungan] }) },
    onError: (e) => toast.error(errMsg(e) || 'Gagal mengirim ulang data'),
  })
  const { data: deliveries = [] } = useQuery({
    queryKey: ['deliveries', idKunjungan],
    queryFn: () => deliveriesApi.list({ id_kunjungan: idKunjungan! }).then((r) => r.data.data),
    enabled: idKunjungan != null,
    refetchInterval: 8000,
  })

  useEffect(() => { const r = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(r) }, [])
  useEffect(() => { sizeRef.current = size }, [size])
  // Re-clamp ukuran kalau viewport mengecil (mis. layar diputar / window dikecilkan).
  useEffect(() => {
    const onR = () => setSize((s) => ({ w: clampW(s.w), h: clampH(s.h) }))
    window.addEventListener('resize', onR)
    return () => window.removeEventListener('resize', onR)
  }, [])
  // Saat popup dibuka, minta backfill histori chat (idempoten + throttled di backend).
  // Polling getMessages akan memunculkan pesan histori beberapa detik kemudian.
  useEffect(() => {
    waApi.requestBackfill(phone).catch(() => { /* best-effort */ })
    waApi.markSeen(phone).catch(() => { /* best-effort */ }) // buka chat → tandai dibaca (centang biru visitor)
  }, [phone])
  // Auto-scroll HANYA bila petugas sedang di dasar, atau pesan terakhir dari kita sendiri.
  // (Jangan menyentak ke bawah saat petugas sedang membaca histori di atas → cegah pesan "terlewat".)
  useEffect(() => {
    const last = messages[messages.length - 1]
    if (!last) return
    if (atBottomRef.current || last.direction === 'out') {
      endRef.current?.scrollIntoView({ behavior: 'smooth' })
      // sinkron dgn posisi scroll: saat memang di dasar, semua pesan dianggap sudah dilihat
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSeenId(last.id)
    }
    // Petugas melihat dasar chat & ada pesan masuk → tandai dibaca (centang biru utk visitor).
    if (atBottomRef.current && last.direction === 'in') waApi.markSeen(phone).catch(() => { /* best-effort */ })
  }, [messages.length, min]) // eslint-disable-line react-hooks/exhaustive-deps
  // Textarea auto-grow (maks ~5 baris).
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'
  }, [text])

  const initial = useMemo(() => (nama || phone || '?').trim().charAt(0).toUpperCase(), [nama, phone])
  const busy = send.isPending

  // Pra-hitung metadata grup (pemisah hari, awal/akhir grup) untuk tampilan ala WhatsApp.
  const items = useMemo(() => messages.map((m, i) => {
    const prev = messages[i - 1]
    const next = messages[i + 1]
    const daySep = (!prev || dayKey(prev.created_at) !== dayKey(m.created_at)) ? dayLabel(m.created_at) : null
    const firstOfGroup = !!daySep || !prev || prev.direction !== m.direction || (msOf(m.created_at) - msOf(prev.created_at)) > GROUP_GAP
    const lastOfGroup = !next || next.direction !== m.direction || (msOf(next.created_at) - msOf(m.created_at)) > GROUP_GAP || dayKey(next.created_at) !== dayKey(m.created_at)
    return { m, daySep, firstOfGroup, lastOfGroup }
  }), [messages])

  const lastId = messages.length ? messages[messages.length - 1].id : 0
  // seenId === 0 = belum ter-seed (sebelum effect mount) → jangan tandai histori sbg "belum dibaca" (cegah kedip).
  const newCount = useMemo(() => (seenId === 0 ? 0 : messages.reduce((n, m) => (m.id > seenId && m.direction === 'in' ? n + 1 : n), 0)), [messages, seenId])
  const firstUnseenId = useMemo(() => (seenId === 0 ? null : (messages.find((m) => m.id > seenId && m.direction === 'in')?.id ?? null)), [messages, seenId])

  function submitText() {
    const b = text.trim()
    if (!b || busy) return
    if (b.length > 4096) { toast.error('Pesan maksimal 4096 karakter'); return }
    send.mutate({ body: b, quoted: replyTo?.id })
  }
  function submitKirimData() {
    if (!idKunjungan) return
    const hasExistingMedia = !!editingDelivery?.media_path
    if (!kdLink.trim() && !kdFile && !hasExistingMedia) { toast.error('Sertakan link atau file'); return }
    if (kdFile && kdFile.size > MAX_BYTES) { toast.error('Ukuran file melebihi 25 MB'); return }
    if (kdFile && !ALLOWED_MIME.includes(kdFile.type)) { toast.error('Tipe file tidak didukung (gambar / pdf / doc / xls)'); return }
    const fd = new FormData()
    fd.append('id_kunjungan', String(idKunjungan))
    if (kdLink.trim()) fd.append('link_url', kdLink.trim())
    if (kdNote.trim()) fd.append('note', kdNote.trim())
    if (kdFile) fd.append('file', kdFile)
    if (editingDelivery) resubmitDelivery.mutate({ id: editingDelivery.id, fd })
    else createDelivery.mutate(fd)
  }

  // ── Scroll tracking: tahu kapan petugas di dasar (untuk auto-scroll & tombol "ke bawah") ──
  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    atBottomRef.current = bottom
    setAtBottom(bottom)
    if (bottom && lastId > seenId) setSeenId(lastId)
  }
  function jumpToLatest() {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
    atBottomRef.current = true
    setAtBottom(true)
    if (lastId > seenId) setSeenId(lastId)
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

  // ── Resize: tepi kiri (lebar), tepi atas (tinggi), sudut kiri-atas (keduanya) ──
  // Popup ber-anchor kanan-bawah → tumbuh ke kiri-atas, jadi delta dibalik (sx - clientX).
  function onResizeDown(e: React.PointerEvent, mode: 'w' | 'h' | 'wh') {
    e.preventDefault(); e.stopPropagation()
    resizeRef.current = { sx: e.clientX, sy: e.clientY, sw: size.w, sh: size.h, mode }
    setResizing(true)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  function onResizeMove(e: React.PointerEvent) {
    const r = resizeRef.current
    if (!r) return
    let w = r.sw, h = r.sh
    if (r.mode.includes('w')) w = clampW(r.sw + (r.sx - e.clientX))
    if (r.mode.includes('h')) h = clampH(r.sh + (r.sy - e.clientY))
    setSize({ w, h })
  }
  function onResizeUp(e: React.PointerEvent) {
    resizeRef.current = null
    setResizing(false)
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* noop */ }
    try { localStorage.setItem(SIZE_KEY, JSON.stringify(sizeRef.current)) } catch { /* ignore */ }
  }
  function resetSize() {
    setSize({ ...DEFAULT_SIZE })
    try { localStorage.removeItem(SIZE_KEY) } catch { /* ignore */ }
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
        className="relative max-w-[calc(100vw-2rem)] rounded-2xl overflow-hidden flex flex-col"
        style={{
          width: size.w,
          opacity: shown ? 1 : 0,
          transform: shown ? 'translateY(0) scale(1)' : 'translateY(10px) scale(.98)',
          transition: resizing ? 'none' : 'opacity .22s ease, transform .22s cubic-bezier(.2,.8,.2,1)',
          height: min ? 'auto' : size.h,
          // Selalu di bawah top nav (56px) — beri jarak nav + gap atas/bawah agar tepi atas
          // popup tak pernah masuk ke belakang nav, di ukuran layar mana pun.
          maxHeight: 'calc(100vh - 88px)',
          background: 'var(--admin-bg, #fff)',
          border: '1px solid var(--admin-border)',
          boxShadow: (dragging || resizing) ? '0 24px 60px -12px rgba(80,50,20,.45)' : '0 18px 44px -16px rgba(80,50,20,.38)',
        }}
      >
        {/* ── Resize handles (sembunyi saat diminimalkan) ── */}
        {!min && (
          <>
            <div
              onPointerDown={(e) => onResizeDown(e, 'wh')} onPointerMove={onResizeMove} onPointerUp={onResizeUp}
              onDoubleClick={resetSize}
              className="absolute top-0 left-0 w-3.5 h-3.5 z-30 cursor-nwse-resize touch-none"
              title="Tarik untuk ubah ukuran (klik 2× untuk reset)"
            />
            <div
              onPointerDown={(e) => onResizeDown(e, 'w')} onPointerMove={onResizeMove} onPointerUp={onResizeUp}
              className="absolute top-0 left-0 w-1.5 h-full z-20 cursor-ew-resize touch-none"
            />
            <div
              onPointerDown={(e) => onResizeDown(e, 'h')} onPointerMove={onResizeMove} onPointerUp={onResizeUp}
              className="absolute top-0 left-0 w-full h-1.5 z-20 cursor-ns-resize touch-none"
            />
          </>
        )}

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
              ref={scrollRef}
              onScroll={onScroll}
              className="relative flex-1 overflow-y-auto px-3 py-3 space-y-0.5"
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
                items.map(({ m, daySep, firstOfGroup, lastOfGroup }) => {
                  const out = m.direction === 'out'
                  const emojiOnly = m.msg_type === 'text' && !!m.body && isEmojiOnly(m.body)
                  return (
                    <div key={m.id}>
                      {daySep && (
                        <div className="flex justify-center py-2 sticky top-1 z-10">
                          <span className="px-2.5 py-0.5 rounded-full text-[10px] font-medium shadow-sm"
                            style={{ background: 'rgba(255,255,255,.92)', color: 'var(--admin-text-muted)' }}>
                            {daySep}
                          </span>
                        </div>
                      )}
                      {firstUnseenId === m.id && (
                        <div className="flex justify-center py-1.5">
                          <span className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold"
                            style={{ background: 'var(--admin-primary-light)', color: 'var(--admin-primary)' }}>
                            {newCount} pesan belum dibaca
                          </span>
                        </div>
                      )}
                      <div className={`group flex items-end gap-1 ${out ? 'justify-end' : 'justify-start'} ${firstOfGroup ? 'mt-2' : 'mt-0.5'} ${m.reaction ? 'mb-2.5' : ''}`}>
                        {out && (
                          <BubbleActions open={reactFor === m.id}
                            onReply={() => setReplyTo({ id: m.id, preview: replyPreview(m), out })}
                            onToggleReact={() => setReactFor((v) => (v === m.id ? null : m.id))}
                            onPick={(e) => { setReactFor(null); react.mutate({ id: m.id, emoji: e }) }} />
                        )}
                        <div className="relative max-w-[78%]">
                          {emojiOnly ? (
                            <div className="flex items-end gap-1.5">
                              <p className="text-4xl leading-tight">{m.body}</p>
                              <span className="text-[10px] mb-1 shrink-0" style={{ color: 'var(--admin-text-muted)' }}>{timeOf(m.created_at)}</span>
                              {out && <span className="mb-1 shrink-0" style={{ color: 'var(--admin-text-muted)' }}><StatusTick status={m.status} ack={m.ack} /></span>}
                            </div>
                          ) : (
                            <div
                              className="px-2.5 py-1.5 text-sm shadow-sm"
                              style={{
                                background: out ? 'var(--admin-primary-light)' : '#fff',
                                color: 'var(--admin-text)',
                                border: out ? '1px solid color-mix(in srgb, var(--admin-primary) 22%, transparent)' : '1px solid var(--admin-border)',
                                borderRadius: out
                                  ? `14px 14px ${lastOfGroup ? 4 : 14}px 14px`
                                  : `14px 14px 14px ${lastOfGroup ? 4 : 14}px`,
                              }}
                            >
                              {m.quoted_preview && (
                                <div className="mb-1 px-2 py-1 rounded-md text-xs border-l-2 line-clamp-2"
                                  style={{ background: out ? 'rgba(255,255,255,.5)' : 'var(--admin-primary-light)', borderColor: 'var(--admin-primary)', color: 'var(--admin-text-secondary)' }}>
                                  {m.quoted_preview}
                                </div>
                              )}
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
                              {m.msg_type === 'sticker' && m.media_url && (
                                <img src={m.media_url} alt="stiker" className="max-h-28 w-auto mb-0.5" loading="lazy" />
                              )}
                              {m.msg_type === 'audio' && m.media_url && (
                                <audio controls src={m.media_url} className="mb-1 h-9 max-w-[230px]" />
                              )}
                              {m.msg_type === 'video' && m.media_url && (
                                <video controls src={m.media_url} className="rounded-lg max-h-52 w-auto mb-1" />
                              )}
                              {m.msg_type === 'location' && (
                                <a href={locationUrl(m.body)} target="_blank" rel="noreferrer"
                                  className="flex items-center gap-2 mb-1 px-2 py-1.5 rounded-lg"
                                  style={{ background: out ? 'rgba(255,255,255,.5)' : 'var(--admin-primary-light)' }}>
                                  <MapPin className="w-5 h-5 shrink-0" style={{ color: 'var(--admin-primary)' }} />
                                  <span className="text-xs font-medium">{locationDesc(m.body) || 'Lihat lokasi di peta'}</span>
                                </a>
                              )}
                              {m.msg_type === 'contact' && (
                                <div className="flex items-center gap-2 mb-1 px-2 py-1.5 rounded-lg"
                                  style={{ background: out ? 'rgba(255,255,255,.5)' : 'var(--admin-primary-light)' }}>
                                  <User className="w-5 h-5 shrink-0" style={{ color: 'var(--admin-primary)' }} />
                                  <span className="text-xs font-medium truncate max-w-[180px]">{vcardName(m.body) || 'Kontak'}</span>
                                </div>
                              )}
                              {m.body && m.msg_type !== 'location' && m.msg_type !== 'contact' && m.msg_type !== 'sticker' && (
                                <p className="whitespace-pre-wrap break-words">{linkify(m.body)}</p>
                              )}
                              <div className="flex items-center gap-1 justify-end mt-0.5" style={{ color: 'var(--admin-text-muted)' }}>
                                <span className="text-[10px]">{timeOf(m.created_at)}</span>
                                {out && <StatusTick status={m.status} ack={m.ack} />}
                              </div>
                            </div>
                          )}
                          {m.reaction && (
                            <span className={`absolute -bottom-2.5 ${out ? 'left-2' : 'right-2'} px-1 rounded-full text-xs shadow-sm`}
                              style={{ background: '#fff', border: '1px solid var(--admin-border)' }}>
                              {m.reaction}
                            </span>
                          )}
                        </div>
                        {!out && (
                          <BubbleActions open={reactFor === m.id}
                            onReply={() => setReplyTo({ id: m.id, preview: replyPreview(m), out })}
                            onToggleReact={() => setReactFor((v) => (v === m.id ? null : m.id))}
                            onPick={(e) => { setReactFor(null); react.mutate({ id: m.id, emoji: e }) }} />
                        )}
                      </div>
                    </div>
                  )
                })
              )}
              <div ref={endRef} />

              {/* Tombol "ke pesan terbaru" — muncul saat petugas scroll ke atas. */}
              {!atBottom && messages.length > 0 && (
                <button
                  onClick={jumpToLatest}
                  className="sticky bottom-1 left-full ml-auto mr-1 grid place-items-center w-9 h-9 rounded-full shadow-md transition-transform active:scale-90"
                  style={{ background: '#fff', border: '1px solid var(--admin-border)', color: 'var(--admin-primary)' }}
                  aria-label="Ke pesan terbaru"
                  title="Ke pesan terbaru"
                >
                  <ChevronDown className="w-5 h-5" />
                  {newCount > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 grid place-items-center rounded-full text-[10px] font-bold text-white"
                      style={{ background: 'var(--admin-primary)' }}>
                      {newCount}
                    </span>
                  )}
                </button>
              )}
            </div>

            {/* ── Tray kiriman data terverifikasi ── */}
            {idKunjungan != null && deliveries.length > 0 && (
              <div className="border-t px-2.5 py-2 space-y-1.5 max-h-36 overflow-y-auto" style={{ borderColor: 'var(--admin-border)', background: '#fdf8f3' }}>
                <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--admin-text-muted)' }}>Kiriman Data</p>
                {deliveries.map((d) => {
                  const lbl = DELIVERY_LABEL[d.status]
                  const href = safeHref(d.link_url ?? undefined)
                  return (
                    <div key={d.id} className="flex items-start gap-2 text-xs rounded-lg px-2 py-1.5" style={{ background: '#fff', border: '1px solid var(--admin-border)' }}>
                      <span className={`shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${lbl.c}`}>{lbl.t}</span>
                      <div className="min-w-0 flex-1 space-y-0.5">
                        {d.note_operator && <p className="truncate" style={{ color: 'var(--admin-text)' }}>{d.note_operator}</p>}
                        {d.link_url && (href
                          ? <a href={href} target="_blank" rel="noreferrer" className="truncate block underline" style={{ color: 'var(--admin-primary)' }}>{d.link_url}</a>
                          : <span className="truncate block" style={{ color: 'var(--admin-text-secondary)' }}>{d.link_url}</span>
                        )}
                        {d.media_name && <p className="truncate" style={{ color: 'var(--admin-text-secondary)' }}>{d.media_name}</p>}
                        {d.status === 'revisi' && d.verif_note && <p className="text-[10px] text-rose-600">Catatan: {d.verif_note}</p>}
                      </div>
                      {d.status === 'revisi' && (
                        <button
                          className="shrink-0 text-[10px] px-2 py-0.5 rounded font-medium"
                          style={{ background: 'var(--admin-primary-light)', color: 'var(--admin-primary)' }}
                          onClick={() => { setEditingDelivery(d); setKdLink(d.link_url || ''); setKdNote(d.note_operator || ''); setKdFile(null); setKirimDataOpen(true) }}
                        >
                          Edit &amp; kirim ulang
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* ── Banner "membalas" (reply) ── */}
            {replyTo && (
              <div className="flex items-center gap-2 px-3 py-1.5 border-t" style={{ borderColor: 'var(--admin-border)', background: 'var(--admin-primary-light)' }}>
                <div className="w-0.5 self-stretch rounded" style={{ background: 'var(--admin-primary)' }} />
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-semibold" style={{ color: 'var(--admin-primary)' }}>Membalas {replyTo.out ? 'pesan Anda' : (nama || 'visitor')}</p>
                  <p className="text-xs truncate" style={{ color: 'var(--admin-text-secondary)' }}>{replyTo.preview}</p>
                </div>
                <button onClick={() => setReplyTo(null)} className="p-1 rounded-full hover:bg-black/5" aria-label="Batal balas">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* ── Form Kirim Data (toggled, operator-only) ── */}
            {kirimDataOpen && (
              <div className="border-t px-2.5 py-2.5 space-y-2" style={{ borderColor: 'var(--admin-border)', background: '#fdf8f3' }}>
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold" style={{ color: 'var(--admin-primary)' }}>
                    {editingDelivery ? 'Edit & Kirim Ulang' : 'Kirim Data'}
                  </p>
                  <button onClick={() => { setKirimDataOpen(false); resetKdForm() }} className="p-0.5 rounded hover:bg-black/5" aria-label="Tutup form Kirim Data">
                    <X className="w-3.5 h-3.5" style={{ color: 'var(--admin-text-muted)' }} />
                  </button>
                </div>
                <input
                  type="url"
                  value={kdLink}
                  onChange={(e) => setKdLink(e.target.value)}
                  placeholder="URL link data (https://...)"
                  className="w-full text-xs px-2.5 py-1.5 rounded-lg outline-none"
                  style={{ background: '#fff', border: '1px solid var(--admin-border)', color: 'var(--admin-text)' }}
                />
                <div className="flex items-center gap-2">
                  <input
                    ref={kdFileRef}
                    type="file"
                    hidden
                    accept={ALLOWED_MIME.join(',')}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) setKdFile(f); e.currentTarget.value = '' }}
                  />
                  <button
                    onClick={() => kdFileRef.current?.click()}
                    className="text-xs px-2 py-1 rounded-lg shrink-0"
                    style={{ background: 'var(--admin-primary-light)', color: 'var(--admin-primary)', border: '1px solid color-mix(in srgb,var(--admin-primary) 20%,transparent)' }}
                  >
                    {kdFile ? kdFile.name.slice(0, 20) + (kdFile.name.length > 20 ? '…' : '') : 'Pilih file'}
                  </button>
                  {kdFile && <button onClick={() => setKdFile(null)} className="text-xs text-red-500 hover:underline">hapus</button>}
                  {!kdFile && editingDelivery?.media_name && (
                    <span className="text-[10px] truncate max-w-[140px]" style={{ color: 'var(--admin-text-muted)' }}>
                      Berkas saat ini: {editingDelivery.media_name}
                    </span>
                  )}
                </div>
                <textarea
                  value={kdNote}
                  onChange={(e) => setKdNote(e.target.value)}
                  placeholder="Catatan (opsional)"
                  rows={2}
                  className="w-full text-xs px-2.5 py-1.5 rounded-lg outline-none resize-none"
                  style={{ background: '#fff', border: '1px solid var(--admin-border)', color: 'var(--admin-text)' }}
                />
                {(createDelivery.isPending || resubmitDelivery.isPending) && kdPct > 0 && (
                  <div className="flex items-center gap-2">
                    <Ring pct={kdPct} />
                    <span className="text-xs" style={{ color: 'var(--admin-text-muted)' }}>Mengunggah… {kdPct}%</span>
                  </div>
                )}
                <button
                  onClick={submitKirimData}
                  disabled={createDelivery.isPending || resubmitDelivery.isPending}
                  className="w-full text-xs py-1.5 rounded-lg font-medium text-white disabled:opacity-40"
                  style={{ background: 'var(--admin-primary)' }}
                >
                  {(createDelivery.isPending || resubmitDelivery.isPending) ? 'Mengirim…' : editingDelivery ? 'Kirim Ulang' : 'Kirim untuk Verifikasi'}
                </button>
              </div>
            )}

            {/* ── Composer ── */}
            <div className="flex items-end gap-1.5 px-2.5 py-2 border-t" style={{ borderColor: 'var(--admin-border)', background: '#fff' }}>
              <button
                onClick={() => { if (kirimDataOpen) { setKirimDataOpen(false); resetKdForm() } else setKirimDataOpen(true) }}
                disabled={!idKunjungan}
                aria-label="Kirim Data"
                title={idKunjungan ? 'Kirim data via jalur terverifikasi' : 'Pemohon belum mengisi formulir'}
                className="p-2 rounded-full shrink-0 transition-colors hover:bg-[var(--admin-primary-light)] disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ color: kirimDataOpen ? 'var(--admin-primary)' : 'var(--admin-text-secondary)' }}
              >
                <Database className="w-5 h-5" />
              </button>
              <textarea
                ref={taRef}
                rows={1}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitText() } }}
                placeholder="Ketik pesan…"
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
