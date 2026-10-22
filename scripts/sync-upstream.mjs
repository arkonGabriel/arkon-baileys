#!/usr/bin/env node
/**
 * Sincroniza o fork Arkon Baileys com o Baileys oficial (WhiskeySockets/Baileys).
 *
 * O que ele faz:
 *   1. garante o remote `upstream` apontando pro Baileys oficial;
 *   2. baixa as novidades (`git fetch`);
 *   3. se houver novidade, cria um branch de sync a partir do `master`;
 *   4. tenta juntar (merge) o oficial preservando TODO o código Arkon;
 *   5. conta o resultado: já-atualizado, juntou-limpo ou deu-conflito.
 *
 * Nunca reescreve histórico e nunca envia nada pro GitHub — quem faz o push/PR
 * é o robô mensal (.github/workflows/sync-fork.yml) ou você, depois de conferir.
 *
 * Variáveis de ambiente (todas opcionais):
 *   UPSTREAM_URL      padrão https://github.com/WhiskeySockets/Baileys.git
 *   UPSTREAM_BRANCH   padrão master
 *   BASE_BRANCH       padrão master
 *   SYNC_BRANCH       padrão arkon/sync-upstream-AAAA-MM-DD
 *   SYNC_DRY_RUN      "1" = só simula (não deixa o merge nem o branch)
 *
 * Saídas: imprime um resumo em português e, se existir $GITHUB_OUTPUT (CI),
 * grava result=uptodate|clean|conflict, branch=..., commits=N, conflicts=a,b,c
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const UPSTREAM_URL = process.env.UPSTREAM_URL || 'https://github.com/WhiskeySockets/Baileys.git'
const UPSTREAM_BRANCH = process.env.UPSTREAM_BRANCH || 'master'
const BASE_BRANCH = process.env.BASE_BRANCH || 'master'
const DRY_RUN = process.env.SYNC_DRY_RUN === '1'

const today = new Date().toISOString().slice(0, 10)
const SYNC_BRANCH = process.env.SYNC_BRANCH || `arkon/sync-upstream-${today}`

const git = (args, { allowFail = false } = {}) => {
	try {
		return execFileSync('git', args, { encoding: 'utf8' }).trim()
	} catch (error) {
		if (allowFail) {
			return { failed: true, stdout: String(error.stdout || ''), stderr: String(error.stderr || '') }
		}

		console.error(`\nFalha no git ${args.join(' ')}:\n${error.stderr || error.message}`)
		process.exit(1)
	}
}

const setOutput = fields => {
	const file = process.env.GITHUB_OUTPUT
	if (!file) {
		return
	}

	const lines = Object.entries(fields).map(([key, value]) => `${key}=${value}`).join('\n')
	appendFileSync(file, `${lines}\n`)
}

const finish = (result, extra = {}) => {
	setOutput({ result, branch: SYNC_BRANCH, ...extra })
	console.log(`\n== resultado: ${result} ==`)
	process.exit(0)
}

// 0. precisa ser um repositório git
git(['rev-parse', '--is-inside-work-tree'])

// 1. garante o remote upstream
const remotes = git(['remote'])
if (remotes.split('\n').includes('upstream')) {
	git(['remote', 'set-url', 'upstream', UPSTREAM_URL])
} else {
	git(['remote', 'add', 'upstream', UPSTREAM_URL])
}
console.log(`upstream = ${UPSTREAM_URL} (branch ${UPSTREAM_BRANCH})`)

// 2. baixa as novidades do oficial
console.log('Baixando novidades do Baileys oficial...')
git(['fetch', 'upstream', UPSTREAM_BRANCH, '--tags', '--prune'])

// 3. tem novidade?
const newCommits = Number(git(['rev-list', '--count', `${BASE_BRANCH}..upstream/${UPSTREAM_BRANCH}`]) || '0')
console.log(`Commits novos no oficial que ainda não estão no fork: ${newCommits}`)
if (newCommits === 0) {
	console.log('O fork já está em dia com o Baileys oficial. Nada a fazer. 🎉')
	finish('uptodate', { commits: 0, conflicts: '' })
}

// 4. cria o branch de sync a partir do master
console.log(`Criando o branch de sync: ${SYNC_BRANCH}`)
git(['checkout', '-B', SYNC_BRANCH, BASE_BRANCH])

// 5. tenta juntar o oficial
console.log('Juntando (merge) o Baileys oficial, preservando o código Arkon...')
const mergeArgs = DRY_RUN
	? ['merge', '--no-commit', '--no-ff', `upstream/${UPSTREAM_BRANCH}`]
	: ['merge', '--no-edit', '--no-ff', `upstream/${UPSTREAM_BRANCH}`]
const merge = git(mergeArgs, { allowFail: true })

const conflicts = git(['diff', '--name-only', '--diff-filter=U'], { allowFail: true })
const conflictList = typeof conflicts === 'string' ? conflicts.split('\n').filter(Boolean) : []

if ((merge && merge.failed) || conflictList.length > 0) {
	console.log(`\nDeu conflito em ${conflictList.length} arquivo(s):`)
	for (const file of conflictList) {
		console.log(`  - ${file}`)
	}

	// desfaz o merge pra deixar o repositório limpo; a resolução é manual
	git(['merge', '--abort'], { allowFail: true })
	git(['checkout', BASE_BRANCH], { allowFail: true })
	console.log('\nMerge desfeito. É preciso resolver os conflitos à mão (rode de novo sem DRY_RUN e resolva).')
	finish('conflict', { commits: newCommits, conflicts: conflictList.join(',') })
}

if (DRY_RUN) {
	console.log('\n(DRY RUN) O merge sairia LIMPO. Desfazendo pra não deixar rastro...')
	git(['merge', '--abort'], { allowFail: true })
	git(['checkout', BASE_BRANCH], { allowFail: true })
}

console.log(`\nJuntou limpo: ${newCommits} commit(s) do oficial entraram${DRY_RUN ? ' (simulação)' : ` no branch ${SYNC_BRANCH}`}.`)
console.log('Depois rode: yarn install, yarn lint, yarn test e yarn build.')
finish('clean', { commits: newCommits, conflicts: '' })
