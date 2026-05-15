export type OptionItem = { value: string; label: string };

export const TIPO_DESPESA_OPTIONS: OptionItem[] = [
  { value: 'MATERIAL_CONSTRUCAO', label: 'Material p/ Construção' },
  { value: 'ELETRODOMESTICO', label: 'Eletrodoméstico' },
  { value: 'REVESTIMENTO', label: 'Revestimento' },
  { value: 'ILUMINACAO', label: 'Iluminação' },
  { value: 'MARMORE', label: 'Mármore' },
  { value: 'VIDRACARIA_SERRALHERIA', label: 'Vidraçaria & Serralheria' },
  { value: 'METAL_CERAMICA', label: 'Metal & Cerâmica' },
  { value: 'MARCENARIA', label: 'Marcenaria' },
  { value: 'MAO_DE_OBRA', label: 'Mão de Obra' },
];

export const CATEGORIA_MAO_DE_OBRA_OPTIONS: OptionItem[] = [
  { value: 'EMPREITEIRO', label: 'Empreiteiro' },
  { value: 'INSTALADOR_PISO', label: 'Instalador de Piso' },
  { value: 'INSTALADOR_MARMORE', label: 'Instalador de Mármore' },
  { value: 'PINTOR', label: 'Pintor' },
  { value: 'ELETRICISTA', label: 'Eletricista' },
  { value: 'VIDRACEIRO', label: 'Vidraceiro' },
  { value: 'SERRALHEIRO', label: 'Serralheiro' },
  { value: 'MARCENEIRO', label: 'Marceneiro' },
];

export const FORMA_PAGAMENTO_OPTIONS: OptionItem[] = [
  { value: 'A_VISTA', label: 'À Vista' },
  { value: 'PARCELADO', label: 'Parcelado' },
  { value: 'QUINZENAL', label: 'Quinzenal' },
];

export const tipoLabel = (t: string): string =>
  TIPO_DESPESA_OPTIONS.find((o) => o.value === t)?.label ?? t;

export const formaLabel = (f: string): string =>
  FORMA_PAGAMENTO_OPTIONS.find((o) => o.value === f)?.label ?? f;

export const catMaoLabel = (c: string): string =>
  CATEGORIA_MAO_DE_OBRA_OPTIONS.find((o) => o.value === c)?.label ?? c;
