'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FileText,
  Paperclip,
  Pencil,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';
import { useProject } from '@/contexts/project-context';
import { api } from '@/lib/api';
import { formatDateBR } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

interface Attachment {
  id: string;
  fileName: string;
  downloadUrl: string;
}

interface VehicleDocument {
  id: string;
  tipo: DocumentType;
  titulo: string;
  numero: string | null;
  dataVencimento: string;
  lembreteAntecedenciaDias: number;
  observacoes: string | null;
  attachments: Attachment[];
}

type DocumentType = 'IPVA' | 'SEGURO' | 'LICENCIAMENTO' | 'OUTRO';

interface FormState {
  tipo: DocumentType;
  titulo: string;
  numero: string;
  dataVencimento: string;
  lembreteAntecedenciaDias: string;
  observacoes: string;
}

const emptyForm: FormState = {
  tipo: 'IPVA',
  titulo: '',
  numero: '',
  dataVencimento: '',
  lembreteAntecedenciaDias: '30',
  observacoes: '',
};

const typeOptions = [
  { value: 'IPVA', label: 'IPVA' },
  { value: 'SEGURO', label: 'Seguro' },
  { value: 'LICENCIAMENTO', label: 'Licenciamento' },
  { value: 'OUTRO', label: 'Outro' },
];

function dueStatus(value: string) {
  const today = new Date();
  const due = new Date(`${value.slice(0, 10)}T00:00:00`);
  const days = Math.ceil(
    (due.getTime() -
      new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
      86_400_000,
  );
  if (days < 0) return { label: 'Vencido', className: 'bg-red-100 text-red-700' };
  if (days <= 30)
    return { label: `Vence em ${days} dias`, className: 'bg-amber-100 text-amber-800' };
  return { label: 'Em dia', className: 'bg-green-100 text-green-700' };
}

export default function VehicleDocumentsPage() {
  const { projectId } = useProject();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [files, setFiles] = useState<File[]>([]);

  const documentsQuery = useQuery<VehicleDocument[]>({
    queryKey: ['vehicle-documents', projectId],
    queryFn: () => api.get(`/projects/${projectId}/vehicle-documents`),
  });

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        ...form,
        numero: form.numero.trim(),
        observacoes: form.observacoes.trim(),
        lembreteAntecedenciaDias: Number(form.lembreteAntecedenciaDias),
      };
      const document = editingId
        ? await api.patch<VehicleDocument>(
            `/projects/${projectId}/vehicle-documents/${editingId}`,
            payload,
          )
        : await api.post<VehicleDocument>(
            `/projects/${projectId}/vehicle-documents`,
            payload,
          );
      if (files.length > 0) {
        if (!editingId) setEditingId(document.id);
        const selectedFiles = files;
        setFiles([]);
        await Promise.all(
          selectedFiles.map((selectedFile) => {
            const upload = new FormData();
            upload.append('file', selectedFile);
            return api.upload(
              `/projects/${projectId}/vehicle-documents/${document.id}/attachments`,
              upload,
            );
          }),
        );
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['vehicle-documents', projectId],
      });
      closeForm();
    },
  });

  const removeDocument = useMutation({
    mutationFn: (id: string) =>
      api.delete(`/projects/${projectId}/vehicle-documents/${id}`),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ['vehicle-documents', projectId],
      }),
  });

  const removeAttachment = useMutation({
    mutationFn: ({
      documentId,
      attachmentId,
    }: {
      documentId: string;
      attachmentId: string;
    }) =>
      api.delete(
        `/projects/${projectId}/vehicle-documents/${documentId}/attachments/${attachmentId}`,
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ['vehicle-documents', projectId],
      }),
  });

  const downloadAttachment = useMutation({
    mutationFn: (attachment: Attachment) =>
      api.download(attachment.downloadUrl, attachment.fileName),
  });

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(emptyForm);
    setFiles([]);
  }

  function startEdit(document: VehicleDocument) {
    setEditingId(document.id);
    setForm({
      tipo: document.tipo,
      titulo: document.titulo,
      numero: document.numero ?? '',
      dataVencimento: document.dataVencimento.slice(0, 10),
      lembreteAntecedenciaDias: String(document.lembreteAntecedenciaDias),
      observacoes: document.observacoes ?? '',
    });
    setFiles([]);
    setShowForm(true);
  }

  if (documentsQuery.isLoading) {
    return <p className="text-darc-velvet/60">Carregando documentos...</p>;
  }
  if (documentsQuery.isError) {
    return <p role="alert" className="text-darc-red">Erro ao carregar documentos.</p>;
  }

  const documents = documentsQuery.data ?? [];

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <FileText className="h-7 w-7 text-darc-red" />
          <div>
            <h1 className="font-editorial text-2xl italic text-darc-velvet">
              Documentos do carro
            </h1>
            <p className="text-sm text-darc-velvet/60">
              IPVA, seguro e licenciamento com aviso automático.
            </p>
          </div>
        </div>
        <Button
          type="button"
          className="min-h-[44px] self-start"
          onClick={() => setShowForm(true)}
        >
          <Plus className="h-4 w-4" /> Novo documento
        </Button>
      </header>

      {showForm && (
        <form
          className="space-y-4 rounded-2xl border border-darc-linen bg-white p-4 shadow-darc-soft"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <h2 className="font-semibold text-darc-velvet">
            {editingId ? 'Editar documento' : 'Novo documento'}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              id="vehicle-document-type"
              label="Tipo"
              value={form.tipo}
              options={typeOptions}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  tipo: event.target.value as DocumentType,
                }))
              }
              required
            />
            <label className="text-sm text-darc-velvet">
              Título
              <Input
                value={form.titulo}
                onChange={(event) =>
                  setForm((current) => ({ ...current, titulo: event.target.value }))
                }
                placeholder="Ex.: Seguro 2027"
                required
              />
            </label>
            <label className="text-sm text-darc-velvet">
              Número / apólice
              <Input
                value={form.numero}
                onChange={(event) =>
                  setForm((current) => ({ ...current, numero: event.target.value }))
                }
              />
            </label>
            <label className="text-sm text-darc-velvet">
              Vencimento
              <Input
                type="date"
                value={form.dataVencimento}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    dataVencimento: event.target.value,
                  }))
                }
                required
              />
            </label>
            <label className="text-sm text-darc-velvet">
              Avisar com antecedência (dias)
              <Input
                type="number"
                min="0"
                max="365"
                value={form.lembreteAntecedenciaDias}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    lembreteAntecedenciaDias: event.target.value,
                  }))
                }
                required
              />
            </label>
            <label className="text-sm text-darc-velvet">
              Anexo (PDF ou imagem)
              <Input
                type="file"
                multiple
                accept=".pdf,image/jpeg,image/png,image/webp"
                onChange={(event) =>
                  setFiles(Array.from(event.target.files ?? []))
                }
              />
            </label>
            <label className="text-sm text-darc-velvet sm:col-span-2">
              Observações
              <Input
                value={form.observacoes}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    observacoes: event.target.value,
                  }))
                }
              />
            </label>
          </div>
          <p className="text-xs text-darc-velvet/60">
            Um lembrete será criado e mantido sincronizado com o vencimento.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" className="min-h-[44px]" disabled={save.isPending}>
              <Upload className="h-4 w-4" />
              {save.isPending ? 'Salvando...' : 'Salvar documento'}
            </Button>
            <Button type="button" variant="ghost" className="min-h-[44px]" onClick={closeForm}>
              Cancelar
            </Button>
          </div>
          {save.error && (
            <p role="alert" className="text-sm text-darc-red">{save.error.message}</p>
          )}
        </form>
      )}

      {documents.length === 0 ? (
        <section className="rounded-2xl border-2 border-dashed border-darc-linen p-10 text-center">
          <FileText className="mx-auto h-9 w-9 text-darc-velvet/40" />
          <p className="mt-3 font-medium text-darc-velvet">Nenhum documento cadastrado.</p>
          <p className="text-sm text-darc-velvet/60">
            Cadastre o próximo vencimento para receber o lembrete.
          </p>
        </section>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {documents.map((document) => {
            const status = dueStatus(document.dataVencimento);
            return (
              <article
                key={document.id}
                className="rounded-2xl border border-darc-linen bg-white p-4 shadow-darc-soft"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-darc-velvet/50">
                      {typeOptions.find((type) => type.value === document.tipo)?.label}
                    </p>
                    <h2 className="font-semibold text-darc-velvet">{document.titulo}</h2>
                    {document.numero && (
                      <p className="text-sm text-darc-velvet/60">Nº {document.numero}</p>
                    )}
                  </div>
                  <span className={`rounded-full px-2 py-1 text-xs font-medium ${status.className}`}>
                    {status.label}
                  </span>
                </div>
                <p className="mt-3 text-sm text-darc-velvet">
                  Vencimento: <strong>{formatDateBR(document.dataVencimento)}</strong>
                </p>
                <p className="text-xs text-darc-velvet/60">
                  Lembrete {document.lembreteAntecedenciaDias} dias antes
                </p>
                {document.observacoes && (
                  <p className="mt-2 text-sm text-darc-velvet/70">{document.observacoes}</p>
                )}
                {document.attachments.length > 0 && (
                  <div className="mt-3 space-y-1">
                    {document.attachments.map((attachment) => (
                      <div key={attachment.id} className="flex min-h-[44px] items-center gap-2">
                        <Paperclip className="h-4 w-4 shrink-0" />
                        <button
                          type="button"
                          className="min-h-[44px] min-w-0 flex-1 truncate text-left text-sm text-darc-red hover:underline"
                          onClick={() => downloadAttachment.mutate(attachment)}
                        >
                          {attachment.fileName}
                        </button>
                        <button
                          type="button"
                          aria-label={`Excluir anexo ${attachment.fileName}`}
                          className="min-h-[44px] min-w-[44px] text-darc-velvet/60"
                          onClick={() =>
                            removeAttachment.mutate({
                              documentId: document.id,
                              attachmentId: attachment.id,
                            })
                          }
                        >
                          <Trash2 className="mx-auto h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex gap-2 border-t border-darc-linen pt-2">
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-[44px]"
                    onClick={() => startEdit(document)}
                  >
                    <Pencil className="h-4 w-4" /> Editar
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-[44px] text-darc-red"
                    onClick={() => {
                      if (confirm('Excluir este documento e o lembrete vinculado?')) {
                        removeDocument.mutate(document.id);
                      }
                    }}
                  >
                    <Trash2 className="h-4 w-4" /> Excluir
                  </Button>
                </div>
                {downloadAttachment.error && (
                  <p role="alert" className="mt-2 text-sm text-darc-red">
                    {downloadAttachment.error.message}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
