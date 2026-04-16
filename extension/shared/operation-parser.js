(function () {
  const FIELD_ALIASES = {
    type: ["tipo", "operacion", "operation", "trade_type"],
    broker: ["broker", "plataforma"],
    symbol: ["ticker", "simbolo", "symbol", "accion", "activo"],
    isin: ["isin"],
    quantity: ["cantidad", "quantity", "shares", "titulos"],
    description: ["descripcion", "description", "concepto", "asset", "nombre"],
    title: ["title", "titulo"],
    buy_date: ["fechaadquisicion", "fecha_compra", "fechacompra", "buydate", "fecha de adquisicion", "fecha compra"],
    sell_date: ["fechatransmision", "fecha_venta", "fechaventa", "selldate", "fecha de transmision", "fecha venta"],
    acquisition_value: ["valoradquisicion", "adquisicion", "importecompra", "compra", "buyamount", "acquisitionvalue", "coste", "costbasis"],
    transmission_value: ["valortransmision", "transmision", "importeventa", "venta", "sellamount", "transmissionvalue", "proceeds"],
    fees: ["gastos", "fees", "comisiones", "commission"],
    result: ["resultado", "gain", "loss", "plusvalia", "minusvalia"],
    notes: ["notas", "notes", "comentarios", "comment"],
    full_name: ["full name", "full_name", "nombre completo", "candidate name", "applicant name"],
    first_name: ["first name", "first_name", "given name"],
    last_name: ["last name", "last_name", "surname", "family name", "apellidos"],
    email: ["email", "e-mail", "correo", "correo electronico"],
    phone: ["phone", "telefono", "mobile", "telefono movil", "movil"],
    location: ["location", "ubicacion", "localizacion", "city", "ciudad"],
    country: ["country", "pais"],
    company: ["company", "empresa", "employer"],
    role: ["role", "puesto", "position", "job title", "vacancy"],
    website: ["website", "web", "sitio web", "personal website"],
    portfolio: ["portfolio", "portafolio", "portfolio url"],
    linkedin: ["linkedin", "linkedin profile", "linkedin url"],
    github: ["github", "github profile", "github url"],
    message: ["mensaje", "message", "cover letter", "motivation", "motivacion", "about you", "summary"],
    cv_url: ["cv", "resume", "curriculum", "curriculum vitae", "resume url", "cv url"]
  };

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function normalizeKey(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "");
  }

  function resolveFieldName(rawKey) {
    const normalized = normalizeKey(rawKey);
    for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
      if (normalizeKey(canonical) === normalized) {
        return canonical;
      }
      if (aliases.some((alias) => normalizeKey(alias) === normalized)) {
        return canonical;
      }
    }
    return normalized || rawKey;
  }

  function inferDelimiter(line) {
    const candidates = [";", "\t", "|", ","];
    let best = ";";
    let bestScore = -1;

    for (const candidate of candidates) {
      const count = line.split(candidate).length - 1;
      if (count > bestScore) {
        best = candidate;
        bestScore = count;
      }
    }

    return best;
  }

  function splitDelimitedLine(line, delimiter) {
    const fields = [];
    let current = "";
    let inQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      const next = line[index + 1];

      if (char === "\"") {
        if (inQuotes && next === "\"") {
          current += "\"";
          index += 1;
          continue;
        }

        inQuotes = !inQuotes;
        continue;
      }

      if (char === delimiter && !inQuotes) {
        fields.push(current.trim());
        current = "";
        continue;
      }

      current += char;
    }

    fields.push(current.trim());
    return fields;
  }

  function finalizeRecord(record) {
    const normalized = { ...record };
    const label = [
      normalized.title,
      normalized.description,
      normalized.full_name,
      normalized.company,
      normalized.role,
      normalized.symbol,
      normalized.isin,
      normalized.email
    ].find(Boolean);

    if (!normalized.full_name && (normalized.first_name || normalized.last_name)) {
      normalized.full_name = [normalized.first_name, normalized.last_name].filter(Boolean).join(" ").trim();
    }

    if (!normalized.title && label) {
      normalized.title = label;
    }

    if (!normalized.description && label) {
      normalized.description = label;
    }

    return normalized;
  }

  function parseJsonRecords(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }

    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed && parsed.records)
        ? parsed.records
        : Array.isArray(parsed && parsed.items)
          ? parsed.items
          : isPlainObject(parsed)
            ? [parsed]
            : null;

    if (!list) {
      return null;
    }

    const records = list
      .filter(isPlainObject)
      .map((item) => Object.fromEntries(
        Object.entries(item).map(([key, value]) => [resolveFieldName(key), value == null ? "" : value])
      ))
      .map(finalizeRecord);

    if (!records.length) {
      return null;
    }

    return {
      mode: "json",
      records
    };
  }

  function parseDelimitedTable(text) {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length < 2) {
      return null;
    }

    const delimiter = inferDelimiter(lines[0]);
    const header = splitDelimitedLine(lines[0], delimiter);
    if (header.length < 2) {
      return null;
    }

    const columns = header.map(resolveFieldName);
    const records = [];

    for (const line of lines.slice(1)) {
      const values = splitDelimitedLine(line, delimiter);
      const record = {};
      columns.forEach((column, index) => {
        record[column] = values[index] || "";
      });
      records.push(finalizeRecord(record));
    }

    return {
      mode: "table",
      delimiter,
      columns,
      records
    };
  }

  function parseKeyValueBlocks(text) {
    const blocks = text
      .trim()
      .split(/\r?\n\s*\r?\n/g)
      .map((block) => block.trim())
      .filter(Boolean);

    if (!blocks.length) {
      return null;
    }

    const records = [];
    for (const block of blocks) {
      const record = {};
      let validLineCount = 0;
      for (const line of block.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
        const separatorIndex = line.indexOf(":");
        if (separatorIndex === -1) {
          continue;
        }

        const key = line.slice(0, separatorIndex).trim();
        const value = line.slice(separatorIndex + 1).trim();
        if (!key) {
          continue;
        }

        record[resolveFieldName(key)] = value;
        validLineCount += 1;
      }

      if (validLineCount > 0) {
        records.push(finalizeRecord(record));
      }
    }

    if (!records.length) {
      return null;
    }

    return {
      mode: "blocks",
      records
    };
  }

  function parseRecordsText(text) {
    const source = String(text || "").trim();
    if (!source) {
      return {
        records: [],
        warnings: ["No se ha recibido texto."]
      };
    }

    const json = parseJsonRecords(source);
    if (json) {
      return {
        records: json.records,
        warnings: [],
        meta: json
      };
    }

    const delimited = parseDelimitedTable(source);
    if (delimited && delimited.records.length) {
      return {
        records: delimited.records,
        warnings: [],
        meta: delimited
      };
    }

    const blocks = parseKeyValueBlocks(source);
    if (blocks && blocks.records.length) {
      return {
        records: blocks.records,
        warnings: [],
        meta: blocks
      };
    }

    return {
      records: [],
      warnings: ["No he podido interpretar el texto. Usa JSON, una tabla o bloques clave: valor."]
    };
  }

  function parseOperationsText(text) {
    return parseRecordsText(text);
  }

  function summarizeRecord(record, index) {
    const label = record.title
      || record.description
      || record.full_name
      || record.company
      || record.email
      || record.symbol
      || record.isin
      || `Registro ${index + 1}`;

    const details = [];
    if (record.role) {
      details.push(record.role);
    }
    if (record.email && record.email !== label) {
      details.push(record.email);
    }
    if (record.phone) {
      details.push(record.phone);
    }
    if (record.buy_date || record.sell_date) {
      details.push(`${record.buy_date || "?"} -> ${record.sell_date || "?"}`);
    }
    if (record.acquisition_value || record.transmission_value) {
      details.push(`${record.acquisition_value || "?"} -> ${record.transmission_value || "?"}`);
    }

    return details.length
      ? `${index + 1}. ${label} | ${details.join(" | ")}`
      : `${index + 1}. ${label}`;
  }

  const parserApi = {
    FIELD_ALIASES,
    normalizeKey,
    parseOperationsText,
    parseRecordsText,
    resolveFieldName,
    summarizeRecord
  };

  globalThis.BrowserAgentParser = parserApi;
})();
