'use client';

import { Modal } from '@/components/ui/modal';
import { typeAccent, TypeIcon } from './type-accent';

interface NewProject {
  name: string;
  type: string;
  description: string;
}

interface CreateProjectModalProps {
  open: boolean;
  onClose: () => void;
  newProject: NewProject;
  setNewProject: React.Dispatch<React.SetStateAction<NewProject>>;
  allowedTypes: string[];
  totalTypes: number;
  isAdmin: boolean;
  creating: boolean;
  createError: string | null;
  onCreate: () => void;
}

const inputClass =
  'w-full bg-lifeone-surface border border-lifeone-hairline rounded-[10px] px-3.5 py-2.5 text-[14px] text-lifeone-ink placeholder:text-lifeone-ink-4 focus:outline-none focus:border-lifeone-blue focus:ring-2 focus:ring-lifeone-blue/25 transition-all';

export function CreateProjectModal({
  open,
  onClose,
  newProject,
  setNewProject,
  allowedTypes,
  totalTypes,
  isAdmin,
  creating,
  createError,
  onCreate,
}: CreateProjectModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Novo Projeto" size="md">
      <div className="space-y-4 font-geist">
        <div>
          <label htmlFor="project-name" className="block text-[12px] font-medium text-lifeone-ink-2 mb-1.5">Nome</label>
          <input
            id="project-name"
            type="text"
            value={newProject.name}
            onChange={(e) => setNewProject((p) => ({ ...p, name: e.target.value }))}
            className={inputClass}
            placeholder="Ex: Reforma do Apartamento"
            autoFocus
          />
        </div>

        <div>
          <span id="project-type-label" className="block text-[12px] font-medium text-lifeone-ink-2 mb-2">Tipo do Projeto</span>
          {allowedTypes.length === 0 ? (
            <div className="text-[13px] text-lifeone-ink-3 bg-lifeone-surface border border-lifeone-hairline rounded-[10px] p-3">
              Você não tem módulos liberados para criar projetos. Peça ao administrador.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3" role="group" aria-labelledby="project-type-label">
              {allowedTypes.map((key) => {
                const accent = typeAccent(key);
                const selected = newProject.type === key;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setNewProject((p) => ({ ...p, type: key }))}
                    className={`p-3 rounded-[12px] border-2 text-left transition-all ${
                      selected
                        ? 'border-lifeone-blue bg-lifeone-info'
                        : 'border-lifeone-hairline hover:border-lifeone-ink-4'
                    }`}
                  >
                    <span
                      className="inline-flex w-9 h-9 rounded-[10px] items-center justify-center"
                      style={{ backgroundColor: accent.fill }}
                    >
                      <TypeIcon type={key} className="w-5 h-5" style={{ color: accent.color }} />
                    </span>
                    <div className="font-semibold mt-1.5 text-[14px] text-lifeone-ink">{accent.label}</div>
                    <div className="text-[12px] text-lifeone-ink-3 leading-snug">{accent.description}</div>
                  </button>
                );
              })}
            </div>
          )}
          {!isAdmin && allowedTypes.length < totalTypes && (
            <p className="text-[12px] text-lifeone-ink-4 mt-2">
              Apenas os tipos para os quais você tem módulos liberados aparecem aqui.
            </p>
          )}
        </div>

        <div>
          <label htmlFor="project-description" className="block text-[12px] font-medium text-lifeone-ink-2 mb-1.5">Descrição (opcional)</label>
          <textarea
            id="project-description"
            value={newProject.description}
            onChange={(e) => setNewProject((p) => ({ ...p, description: e.target.value }))}
            className={inputClass}
            rows={2}
            placeholder="Breve descrição do projeto"
          />
        </div>

        {createError && (
          <div role="alert" className="text-[13px] text-[#B42318] bg-[#FEF3F2] border border-[#FECDCA] rounded-[10px] px-3 py-2.5">
            {createError}
          </div>
        )}
      </div>

      <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-lifeone-hairline">
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2.5 text-[14px] font-medium text-lifeone-ink-2 hover:text-lifeone-ink transition-colors"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={onCreate}
          disabled={creating || !newProject.name.trim() || !newProject.type}
          className="px-4 py-2.5 bg-lifeone-blue text-[#FFFFFF] text-[14px] font-semibold rounded-[10px] hover:brightness-95 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
        >
          {creating ? 'Criando...' : 'Criar Projeto'}
        </button>
      </div>
    </Modal>
  );
}
