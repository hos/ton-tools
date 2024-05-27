import { Pool, Query, type QueryConfig } from "pg";
import { DATABASE_URL } from "../../config";
import { logger } from "../../logger";

export const pgClient = new Pool({ connectionString: DATABASE_URL });

export const pgPool = pgClient;

const submit = Query.prototype.submit;

Query.prototype.submit = function patchedSubmit() {
  try {
    const text = (this as any).text;
    const values = (this as any).values || [];
    const query = text.replace(/\$([0-9]+)/g, (m: any, v: any) => {
      const value = values[parseInt(v, 10) - 1];
      if (typeof value === "string") return `'${value}'`;
      if (value instanceof Date) return `'${value.toISOString()}'::timestamptz`;
      if (value instanceof Number) return value.toString();
      return JSON.stringify(values[parseInt(v, 10) - 1], (key, value) =>
        typeof value === "bigint" ? value.toString() : value
      );
    });

    if (/--debug/i.test(query)) {
      logger.log(query);
    }
  } catch (error) {
    logger.error(error);
  }
  // @ts-expect-error
  submit.apply(this, arguments);
};

pgClient.on("error", (err, client): void => {
  logger.error(err, client);
});

export interface Transactions {
  id: string; // bigint
  from_address: string;
  to_address: string;
  lt: string;
  hash: string;
  message: string | null;
  transaction_created_at: Date;
  amount: string;
  created_at: Date;
  updated_at: Date;
  prev_lt: string | null;
  prev_hash: string | null;
}

export interface TransactionsInitializer {
  id?: string; // bigint
  from_address: string;
  to_address: string;
  lt: string;
  hash: string;
  message?: string | null;
  transaction_created_at: Date;
  amount: string;
  created_at?: Date;
  updated_at?: Date;
  prev_lt?: string | null;
  prev_hash?: string | null;
}

export interface Addresses {
  id: string; // bigint
  address: string;
  created_at: Date;
  updated_at: Date;
}

export interface AddressesInitializer {
  id?: string; // bigint
  address: string;
  created_at?: Date;
  updated_at?: Date;
}

type Tables = {
  transactions: {
    insert: TransactionsInitializer;
    select: Transactions;
  };
  addresses: {
    insert: AddressesInitializer;
    select: Addresses;
  };
};

type TValues = string | number | Date | boolean | null | unknown; // unknown is used for json data type

interface InsertQueryOptions<TTableName extends keyof Tables> {
  tableName: TTableName;
  records: Tables[TTableName]["insert"] | Tables[TTableName]["insert"][];
  schemaName?: string;
  return?: boolean;
  onConflict?: string;
  debug?: boolean;
}

export interface InsertQueryResult {
  query: string;
  params: unknown[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const InsertQuery = <TTableName extends keyof Tables = any>(
  options: InsertQueryOptions<TTableName>
): InsertQueryResult => {
  const { tableName, onConflict, schemaName = "" } = options;
  const records = Array.isArray(options.records)
    ? options.records
    : [options.records];
  const columns: (keyof Tables[TTableName])[] = [];
  const params: string[] = [];
  const values: QueryConfig["values"] = [];

  const addValue = (column: keyof Tables[TTableName], value: TValues) => {
    if (!columns.includes(column)) {
      columns.push(column);
    }
    params.push(`$${values.push(value)}`);
  };

  const getQuery = () => {
    const chunk = columns.length;
    const str = params
      .map((_, index) => {
        return index % chunk === 0
          ? `(${params.slice(index, index + chunk).join(", ")})`
          : "";
      })
      .filter((item) => !!item)
      .join(options.debug ? ",\n" : ",");
    return str;
  };

  const getQueryAndParams = () => {
    const str = getQuery();
    const query = [
      options.debug ? "--debug" : "",
      `INSERT INTO ${
        schemaName ? `${schemaName}.` : ""
      }${tableName} (${columns.join(", ")}) VALUES `,
      `${str}`,
      onConflict,
      options.return ? "RETURNING *" : "",
    ].join(options.debug ? "\n" : "");

    return {
      query,
      params: values,
    };
  };

  const allKeys = Array.from(
    new Set(records.map((record) => Object.keys(record)).flat())
  );

  records.forEach((record) => {
    allKeys.forEach((key) => {
      addValue(
        key as keyof Tables[TTableName],
        record[key as keyof Tables[TTableName]["insert"]]
      );
    });
  });

  return getQueryAndParams();
};
