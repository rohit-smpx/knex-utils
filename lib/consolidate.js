const Knex = require('knex');
const {file, Str} = require('sm-utils');
const d = require('sm-utils/d');
const {getKnex, getLogger} = require('./index');

const tablesToIgnore = ['knex_migrations', 'knex_migrations_lock'];

/**
 * @typedef {{table_schema: string, table_name: string, table_type: string}} table
 */

/**
 * @returns {Promise<table[]>}
 */
async function getTables() {
	return (await getKnex().from('information_schema.tables').where('table_schema', 'public')
		).filter((table) => {
			if (tablesToIgnore.includes(table.table_name)) return false;
			return true;
		});
}

/**
 * @typedef {{index_name: string, table_name: string, indexed_columns: string[], is_unique: boolean, is_primary: boolean}} indexInfo 
 */

/**
 * @see https://stackoverflow.com/a/6777904/9485498
 * @param {string} tableName 
 * @returns {Promise<indexInfo[]>}
 */
async function getIndexes(tableName) {
	return (await getKnex().raw(`\
	SELECT
	U.usename                AS user_name,
	ns.nspname               AS schema_name,
	idx.indrelid :: REGCLASS AS table_name,
	i.relname                AS index_name,
	idx.indisunique          AS is_unique,
	idx.indisprimary         AS is_primary,
	am.amname                AS index_type,
	idx.indkey,
		 ARRAY(
			 SELECT pg_get_indexdef(idx.indexrelid, k + 1, TRUE)
			 FROM
			   generate_subscripts(idx.indkey, 1) AS k
			 ORDER BY k
		 ) AS indexed_columns,
	(idx.indexprs IS NOT NULL) OR (idx.indkey::int[] @> array[0]) AS is_functional,
	idx.indpred IS NOT NULL AS is_partial
	FROM pg_index AS idx
		JOIN pg_class AS i
		ON i.oid = idx.indexrelid
		JOIN pg_am AS am
		ON i.relam = am.oid
		JOIN pg_namespace AS NS ON i.relnamespace = NS.OID
		JOIN pg_user AS U ON i.relowner = U.usesysid
	AND idx.indrelid :: REGCLASS = '"${tableName}"' :: REGCLASS;`)).rows;
}

/**
 * Row from information_schema.columns
 * listing only important stuff
 * @typedef {object} detailedColumnInfo
 * @property {string} table_name
 * @property {string} column_name
 * @property {number} ordinal_position
 * @property {string} column_default
 * @property {string} data_type
 * @property {number | null} character_maximum_length
 * @property {number | null} numeric_precision
 */

/**
 * @typedef {Knex.ColumnInfo & {detailedInfo: detailedColumnInfo}} columnInfoSimple
 */

/**
 * @typedef {columnInfoSimple & {index?: indexInfo}} columnInfo
 */

/**
 * @param {string} tableName 
 * @returns {Promise<{[key: string]: columnInfoSimple}>}
 */
async function getColumns(tableName) {
	const columnsInfo = await getKnex().table(tableName).columnInfo();
	const detailedInfo = await getKnex().from('information_schema.columns').where('table_name', tableName);
	detailedInfo.forEach((columnDetailed) => {
		columnsInfo[columnDetailed.column_name].detailedInfo = columnDetailed;
	});
	return columnsInfo;
}

/**
 * @param {columnInfo} columnInfo 
 */
function getType(columnInfo) {
	/** @type {{[key: string]: string}} */
	const map = {
		'integer': 'integer',
		'character varying': 'string',
		'jsonb': 'jsonb',
		'timestamp with time zone': 'timestamp',
		'text': 'text',
		'boolean': 'boolean',
		'real': 'float',
		'numeric': 'decimal',
		'USER-DEFINED': 'specificType',
	};
	let type = map[columnInfo.type];
	if (!type) throw new Error('invalid type');

	/** @type {string[]} */
	let extraParams;

	switch(type) {
		case 'specificType':
			extraParams = [`'${columnInfo.defaultValue.match(/::([\s\w]+)$/)[1]}'`];
			break;
		case 'integer':
			if (columnInfo.defaultValue && columnInfo.defaultValue.startsWith('nextval')) {
				type = 'increments';
			}
			break;
		case 'string':
			if (columnInfo.detailedInfo.character_maximum_length) {
				extraParams = [columnInfo.detailedInfo.character_maximum_length];
			}
			break;
		case 'numeric': {
			if (columnInfo.detailedInfo.numeric_precision) {
				extraParams = [columnInfo.detailedInfo.numeric_precision];
			}
			break;
		}
	}

	return {type, extraParams};
}

/**
 * 
 * @param {columnInfo} columnInfo 
 */
function nullable(columnInfo) {
	if (columnInfo.index && columnInfo.index.is_primary) return '';
	if (columnInfo.nullable === true) return '.nullable()';
	if (columnInfo.nullable === false) return '.notNullable()';
}

/**
 * @param {columnInfo} columnInfo 
 */
function defaults(columnInfo) {
	if (columnInfo.defaultValue === null) return '';
	const {type} = getType(columnInfo);
	if (type === 'increments') return '';
	
	let defaultVal = columnInfo.defaultValue.match(/^('.*')(::[\w\s]+)?$/);
	if (defaultVal) {
		defaultVal = defaultVal[1].replace(/\\'/, "'");
	}
	else if (type === 'numeric' || type === 'integer') {
		defaultVal = Number(columnInfo.defaultValue.replace("'", ''));
		if (Number.isNaN(defaultVal)) {
			getLogger().warn(`[knex-utils] default value is invalid, ${columnInfo.defaultValue}, for type ${type}.`,
				`Table ${columnInfo.detailedInfo.table_name}, Column ${columnInfo.detailedInfo.column_name}`);
			return '';
		}
	}
	else if (type === 'boolean') {
		defaultVal = Str.tryParseJson(columnInfo.defaultValue.replace("'", ''));
		if (defaultVal === null) {
			getLogger().warn(`[knex-utils] default value is invalid, ${columnInfo.defaultValue}, for type ${type}.`,
				`Table ${columnInfo.detailedInfo.table_name}, Column ${columnInfo.detailedInfo.column_name}`);
			return '';
		}
	}
	else {
		return '';
	}
	return `.defaultTo(${defaultVal})`;
}

/**
 * @param {columnInfo} columnInfo 
 */
function indexed(columnInfo) {
	if (!columnInfo.index || !columnInfo.index.single) return '';
	if (columnInfo.index.is_primary) return '';
	if (columnInfo.index.is_unique) return '.unique()';
	return '.index()';
}

function primary(columnInfo) {
	if (!columnInfo.index || !columnInfo.index.single) return '';
	if (columnInfo.index.is_primary) return '.primary()';
	return '';
}

/**
 * 
 * @param {table} table 
 * @param {{[key: string]: columnInfo}} columnsInfo
 * @param {indexInfo[]} indexInfo
 */
async function singleTableGenerator(table, columnsInfo, indexInfo) {
	let extra = '';
	let extrasDone = {
		citext: false,
	}
	const columns = Object.keys(columnsInfo).map((columnName) => {
		const columnInfo = columnsInfo[columnName];

		let {type, extraParams} = getType(columnInfo);
		if (type === 'specificType') {
			if (extraParams[0] === "'citext'") {
				// So that query is not added multiple times
				if (!extrasDone.citext)
					extra += "\n\t\t.raw('CREATE EXTENSION IF NOT EXISTS CITEXT')"
				extrasDone.citext = true;
			}
			else {
				getLogger().warn(`[knex-utils] the specified type "${extraParams}" may not exist for column: "${columnName}" in table "${table.table_name}"`);
			}
		}

		if (extraParams && extraParams.length) extraParams = `, ${extraParams.join(', ')}`;
		else extraParams = '';
		return `\
			table.${type}('${columnName}'${extraParams})${primary(columnInfo)}` +
			`${nullable(columnInfo)}${defaults(columnInfo)}` +
			`${indexed(columnInfo)};`;
	}).join('\n');

	const indexes = indexInfo.filter(i => !i.single).map(index => {
		if (index.multiple) {
			const columnsArrStr = index.indexed_columns.map(c => `'${c.replace(/"/g, '')}'`).join(', ');
			if (index.is_primary) {
				return `\
			table.primary([${columnsArrStr}]);`
			}
			if (index.is_unique && index.multiple) {
				return `\
			table.unique([${columnsArrStr}]);`
			}
			return `\
			table.index([${columnsArrStr}]);`
		}
		getLogger().warn('[knex-utils] Unknown index type', index);
		return '';
	}).join('\n');

	return `\
exports.up = async function (knex) {
	return knex.schema${extra}
		.createTable('${table.table_name}', (table) => {\n${columns}${indexes ? '\n' : ''}${indexes}
		});
};

exports.down = async function (knex) {
	return knex.schema
		.dropTableIfExists('${table.table_name}');
};`
}

async function generate() {
	const tables = await getTables();
	await file(`${process.cwd()}/migrations/tables`).mkdirp();
	await Promise.all(tables.map(async (table) => {
		const columnsInfo = await getColumns(table.table_name);
		const indexes = (await getIndexes(table.table_name)).map((i) => {
			if (i.indexed_columns.length === 1) {
				const col = columnsInfo[i.indexed_columns[0].replace(/"/g, '')];
				if (!col) {
					i.error = true;
					getLogger().warn(Object.keys(columnsInfo), i.indexed_columns[0].replace(/"/g, ''));
					return i;
				}
				i.single = true;
				col.index = i;
			}
			else i.multiple = true;
			return i;
		});	
		const tableMigration = await singleTableGenerator(table, columnsInfo, indexes);
		return file(`${process.cwd()}/migrations/tables/create${table.table_name}.js`).write(tableMigration);
	}));

	const indexFile = `\
${tables.map(table => `const ${table.table_name} = require('./tables/create${table.table_name}');`).join('\n')}

exports.up = async function (knex) {
	await Promise.all([
		${tables.map(table => `${table.table_name}.up(knex),`).join('\n\t\t')}
	])
};

exports.down = async function (knex) {
	await Promise.all([
		${tables.map(table => `${table.table_name}.down(knex),`).join('\n\t\t')}
	])
};`
	await file(`${process.cwd()}/migrations/index.js`).write(indexFile);
}

if (require.main === module) {
	generate().catch(err => {
		console.error(err);
		process.exit(1);
	}).then(() => {
		process.exit(0);
	});
}