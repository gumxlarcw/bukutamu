import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { getApiErrorMessage } from '@/lib/apiError'
import { deliveriesApi } from '@/api/deliveries'
import type { DataDeliveryDetail, DeliveryStatus, VerifDecision } from '@/types/delivery'
import { cn } from '@/lib/utils'
import { safeHref } from '@/lib/url'
import { FileText, Download, ExternalLink, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/shared/EmptyState'

// ── helpers ──────────────────────────────────────────────────────────────────

function getApiMessage(e: unknown): string {
  return getApiErrorMessage(e)
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso.replace(' ', 'T'))
  if (isNaN(d.getTime())) return iso
  return d.toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function statusBadgeCls(status: DeliveryStatus): string {
  switch (status) {
    case 'menunggu_verifikasi': return 'bg-amber-100 text-amber-700'
    case 'revisi': return 'bg-rose-100 text-rose-700'
    case 'disetujui':
    case 'terkirim': return 'bg-emerald-100 text-emerald-700'
    case 'dibatalkan': return 'bg-zinc-100 text-zinc-600'
    default: return 'bg-gray-100 text-gray-600'
  }
}

const STATUS_LABEL: Record<DeliveryStatus, string> = {
  menunggu_verifikasi: 'Menunggu Verifikasi',
  revisi: 'Revisi',
  disetujui: 'Disetujui',
  terkirim: 'Terkirim',
  dibatalkan: 'Dibatalkan',
}

function ChannelBadge({ channel }: { channel: 'online' | 'offline' }) {
  return (
    <span className={cn(
      'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium',
      channel === 'online' ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700'
    )}>
      {channel === 'online' ? 'Online' : 'Offline'}
    </span>
  )
}

// ── DeliveryCard ──────────────────────────────────────────────────────────────

interface DeliveryCardProps {
  item: DataDeliveryDetail
  showActions: boolean
  actionOpen: boolean
  actionDecision: 'revisi' | 'setuju_catatan' | null
  actionNote: string
  onActionNoteChange: (note: string) => void
  onSetuju: () => void
  onOpenAction: (decision: 'revisi' | 'setuju_catatan') => void
  onSubmitAction: () => void
  onCancelAction: () => void
  isPending: boolean
}

function DeliveryCard({
  item,
  showActions,
  actionOpen,
  actionDecision,
  actionNote,
  onActionNoteChange,
  onSetuju,
  onOpenAction,
  onSubmitAction,
  onCancelAction,
  isPending,
}: DeliveryCardProps) {
  const isImage = item.media_mime ? item.media_mime.startsWith('image/') : false
  const fileUrl = item.media_path ? deliveriesApi.fileUrl(item.id) : null

  return (
    <div className="admin-card overflow-hidden">
      <div className="p-4 space-y-3">
        {/* Header: pemohon info + status badge */}
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm" style={{ color: 'var(--admin-text)' }}>
                {item.pemohon_nama || '(tanpa nama)'}
              </span>
              {item.instansi && (
                <span className="text-xs truncate" style={{ color: 'var(--admin-text-muted)' }}>· {item.instansi}</span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {item.nomor_antrian && (
                <span className="font-mono text-[11px] px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--admin-primary-light)', color: 'var(--admin-primary)' }}>
                  {item.nomor_antrian}
                </span>
              )}
              {item.short_code && (
                <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600">
                  {item.short_code}
                </span>
              )}
              <ChannelBadge channel={item.channel} />
            </div>
          </div>
          <span className={cn('shrink-0 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium', statusBadgeCls(item.status))}>
            {STATUS_LABEL[item.status] ?? item.status}
          </span>
        </div>

        {/* Requested data */}
        {(item.rincian_data || item.wilayah_data || item.tahun_awal) && (
          <div className="p-2.5 rounded-lg text-xs space-y-1" style={{ background: 'var(--admin-primary-light)' }}>
            {item.rincian_data && (
              <p style={{ color: 'var(--admin-text)' }}>
                <span className="font-medium">Data: </span>{item.rincian_data}
              </p>
            )}
            {item.wilayah_data && (
              <p style={{ color: 'var(--admin-text-secondary)' }}>
                <span className="font-medium">Wilayah: </span>{item.wilayah_data}
              </p>
            )}
            {(item.tahun_awal || item.tahun_akhir) && (
              <p style={{ color: 'var(--admin-text-secondary)' }}>
                <span className="font-medium">Tahun: </span>
                {item.tahun_awal ?? '—'}
                {item.tahun_akhir && item.tahun_akhir !== item.tahun_awal ? ` – ${item.tahun_akhir}` : ''}
              </p>
            )}
          </div>
        )}

        {/* Deliverable: link or file (mirrors ChatPopup.tsx image/document display) */}
        {(item.link_url || fileUrl) && (
          <div className="flex flex-wrap items-start gap-2">
            {item.link_url && (() => {
              const href = safeHref(item.link_url)
              return href ? (
                <a href={href} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors hover:opacity-80"
                  style={{ color: 'var(--admin-primary)', borderColor: 'color-mix(in srgb, var(--admin-primary) 30%, transparent)', background: 'var(--admin-primary-light)' }}>
                  <ExternalLink className="w-3.5 h-3.5" /> Buka Tautan
                </a>
              ) : (
                // Unsafe scheme (e.g. javascript:) — show as inert text so verifier can still read and reject it
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border"
                  style={{ color: 'var(--admin-text-muted)', borderColor: 'var(--admin-border)', background: 'var(--admin-primary-light)' }}>
                  <ExternalLink className="w-3.5 h-3.5 opacity-40" />
                  <span className="break-all">{item.link_url}</span>
                </span>
              )
            })()}
            {fileUrl && isImage && (
              <a href={fileUrl} target="_blank" rel="noreferrer" className="block">
                <img src={fileUrl} alt={item.media_name || 'file'} className="rounded-lg max-h-40 max-w-xs object-cover" loading="lazy" />
              </a>
            )}
            {fileUrl && !isImage && (
              <a href={fileUrl} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm border"
                style={{ background: 'var(--admin-primary-light)', color: 'var(--admin-text)', borderColor: 'var(--admin-border)' }}>
                <FileText className="w-4 h-4 shrink-0" style={{ color: 'var(--admin-primary)' }} />
                <span className="truncate max-w-[200px]">{item.media_name || 'dokumen'}</span>
                <Download className="w-3.5 h-3.5 ml-1 opacity-60 shrink-0" />
              </a>
            )}
          </div>
        )}

        {/* Operator note */}
        {item.note_operator && (
          <p className="text-xs italic" style={{ color: 'var(--admin-text-secondary)' }}>
            Catatan operator: {item.note_operator}
          </p>
        )}

        {/* Verif note (visible in Riwayat) */}
        {item.verif_note && (
          <p className="text-xs" style={{ color: 'var(--admin-text-secondary)' }}>
            Catatan verifikator: {item.verif_note}
          </p>
        )}

        {/* Timestamp */}
        <p className="text-[11px]" style={{ color: 'var(--admin-text-muted)' }}>
          Diterima: {formatDate(item.created_at)}
        </p>

        {/* Actions — Menunggu only */}
        {showActions && !actionOpen && (
          <div className="flex items-center gap-2 pt-1 border-t flex-wrap" style={{ borderColor: 'var(--admin-border)' }}>
            <Button
              size="sm"
              disabled={isPending}
              onClick={onSetuju}
              className="bg-emerald-600 hover:bg-emerald-700 text-white border-transparent"
            >
              <Check className="w-3.5 h-3.5 mr-1" /> Setuju
            </Button>
            <Button size="sm" variant="outline" disabled={isPending} onClick={() => onOpenAction('setuju_catatan')}>
              Setuju + Catatan…
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={isPending}
              className="text-rose-600 border-rose-200 hover:bg-rose-50"
              onClick={() => onOpenAction('revisi')}
            >
              Revisi…
            </Button>
          </div>
        )}
      </div>

      {/* Inline action textarea — expands below the card content */}
      {showActions && actionOpen && actionDecision && (
        <div className="px-4 pb-4 pt-0 border-t space-y-2" style={{ borderColor: 'var(--admin-border)', background: 'var(--admin-primary-light)' }}>
          <p className="text-xs font-medium pt-3" style={{ color: 'var(--admin-text)' }}>
            {actionDecision === 'revisi' ? 'Catatan revisi (wajib):' : 'Catatan tambahan (opsional):'}
          </p>
          <textarea
            rows={3}
            value={actionNote}
            onChange={(e) => onActionNoteChange(e.target.value)}
            placeholder={actionDecision === 'revisi' ? 'Jelaskan apa yang perlu diperbaiki…' : 'Catatan untuk pemohon (opsional)…'}
            className="w-full text-sm rounded-lg px-3 py-2 outline-none resize-none"
            style={{ background: '#fff', border: '1.5px solid var(--admin-border-strong)', color: 'var(--admin-text)' }}
            autoFocus
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={isPending}
              onClick={onSubmitAction}
              className={cn(
                'border-transparent text-white',
                actionDecision === 'revisi'
                  ? 'bg-rose-600 hover:bg-rose-700'
                  : 'bg-emerald-600 hover:bg-emerald-700'
              )}
            >
              {actionDecision === 'revisi' ? 'Kirim Revisi' : 'Setuju + Kirim Catatan'}
            </Button>
            <Button size="sm" variant="outline" disabled={isPending} onClick={onCancelAction}>
              Batal
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── VerifikasiPage ────────────────────────────────────────────────────────────

type ActionState = { id: number; decision: 'revisi' | 'setuju_catatan'; note: string } | null

export default function VerifikasiPage() {
  const qc = useQueryClient()
  const [action, setAction] = useState<ActionState>(null)

  // Single query; split Menunggu / Riwayat client-side to avoid double-fetch.
  // limit:100 sidesteps pagination — verifikator queue is operationally small.
  const { data, isLoading } = useQuery({
    queryKey: ['deliveries'],
    queryFn: () => deliveriesApi.list({ limit: 100 }).then(r => r.data.data),
    refetchInterval: 15000,
  })

  const items: DataDeliveryDetail[] = data ?? []
  const menungguItems = items.filter(d => d.status === 'menunggu_verifikasi')
  const riwayatItems  = items.filter(d => d.status !== 'menunggu_verifikasi')

  const verify = useMutation({
    mutationFn: (v: { id: number; decision: VerifDecision; note?: string }) =>
      deliveriesApi.verify(v.id, v.decision, v.note),
    onSuccess: () => {
      toast.success('Keputusan tersimpan')
      setAction(null)
      qc.invalidateQueries({ queryKey: ['deliveries'] })
    },
    onError: (e) => toast.error(getApiMessage(e)),
  })

  function handleSetuju(id: number) {
    verify.mutate({ id, decision: 'setuju' })
  }

  function handleOpenAction(id: number, decision: 'revisi' | 'setuju_catatan') {
    setAction({ id, decision, note: '' })
  }

  function handleSubmitAction() {
    if (!action) return
    if (action.decision === 'revisi' && !action.note.trim()) {
      toast.error('Revisi wajib menyertakan catatan')
      return
    }
    verify.mutate({
      id: action.id,
      decision: action.decision,
      note: action.note.trim() || undefined,
    })
  }

  return (
    <div className="space-y-6 admin-enter">
      {/* Page header */}
      <div>
        <h1 className="admin-h1">Verifikasi Data</h1>
        <p className="admin-subtitle">Antrian pengiriman data yang menunggu persetujuan verifikator</p>
      </div>

      {/* ── Menunggu Verifikasi ── */}
      <section>
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2" style={{ color: 'var(--admin-text)' }}>
          Menunggu Verifikasi
          {menungguItems.length > 0 && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-700">
              {menungguItems.length}
            </span>
          )}
        </h2>
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-36 rounded-xl" />)}
          </div>
        ) : menungguItems.length === 0 ? (
          <EmptyState icon="✅" message="Tidak ada antrian verifikasi" action="Semua pengiriman data sudah diproses." />
        ) : (
          <div className="space-y-3">
            {menungguItems.map(item => (
              <DeliveryCard
                key={item.id}
                item={item}
                showActions={true}
                actionOpen={action?.id === item.id}
                actionDecision={action?.id === item.id ? action.decision : null}
                actionNote={action?.id === item.id ? action.note : ''}
                onActionNoteChange={(note) => setAction(a => a ? { ...a, note } : null)}
                onSetuju={() => handleSetuju(item.id)}
                onOpenAction={(decision) => handleOpenAction(item.id, decision)}
                onSubmitAction={handleSubmitAction}
                onCancelAction={() => setAction(null)}
                isPending={verify.isPending && verify.variables?.id === item.id}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Riwayat ── */}
      <section>
        <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--admin-text)' }}>
          Riwayat
        </h2>
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
          </div>
        ) : riwayatItems.length === 0 ? (
          <EmptyState icon="📋" message="Belum ada riwayat verifikasi" action="Verifikasi yang sudah diproses akan muncul di sini." />
        ) : (
          <div className="space-y-3">
            {riwayatItems.map(item => (
              <DeliveryCard
                key={item.id}
                item={item}
                showActions={false}
                actionOpen={false}
                actionDecision={null}
                actionNote=""
                onActionNoteChange={() => {}}
                onSetuju={() => {}}
                onOpenAction={() => {}}
                onSubmitAction={() => {}}
                onCancelAction={() => {}}
                isPending={false}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
