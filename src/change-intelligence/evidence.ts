import { Confidence, EvidenceEntry } from "./types.js";

export function scoreConfidence(evidences: EvidenceEntry[]): Confidence {
  const types = new Set(evidences.map(e => e.type));
  
  // High: focus_path explícito e válido;
  // path literal extraído do objetivo e existente;
  if (types.has("focus_path") || types.has("extracted_path")) {
    return "high";
  }
  
  // rota/schema diretamente correspondente;
  if (types.has("route") || types.has("schema")) {
    return "high";
  }
  
  // correspondência exata de basename + outro sinal;
  // filename exato + import/test proximity.
  if (types.has("filename_exact")) {
    if (types.size >= 2) {
      return "high";
    }
    // If it's the only one, wait, the rule says "filename exato + import/test proximity" -> high,
    // "correspondência exata de basename + outro sinal" -> high. 
    // If it has >= 2 signals (filename_exact + something else), it's high.
  }

  // Medium:
  // duas categorias distintas de evidência;
  // correspondência parcial de filename;
  // teste detectado por convenção (test_proximity without filename_exact is already >= 2 or test_proximity itself);
  // relação estrutural sem correspondência exata (import).
  if (types.has("filename_exact") && types.size === 1) {
    return "medium"; // Just exact filename, no other signals.
  }
  
  if (types.has("filename_partial") || types.has("test_proximity") || types.has("import")) {
    return "medium";
  }
  
  if (types.size >= 2) {
    return "medium";
  }

  // Low:
  // somente content_match;
  // somente task_type;
  // termo genérico encontrado em muitos arquivos.
  return "low";
}
