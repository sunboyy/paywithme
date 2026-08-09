<script lang="ts">
	// `/docs/api` — quickstart + conventions for the public API (PLAN §16.9).
	//
	// Deliberately prose-only: a quickstart (one copy-pasteable read + write worked
	// example), the cross-cutting conventions (auth, scopes, money, errors,
	// idempotency, rate limits, pagination), and a prominent link to the raw spec.
	// PER-ENDPOINT SHAPES ARE NOT REPEATED HERE — they live in the OpenAPI spec, the
	// single source of truth, so this page cannot drift from the contract. The
	// quickstart's bodies come from `$lib/docs/api-quickstart` (via the load), which
	// the contract test validates against the spec's schemas.
	//
	// Mobile-first (PLAN §10): every code block scrolls horizontally inside its own
	// box rather than pushing the page wide.
	import { resolve } from '$app/paths';
	import * as Card from '$lib/components/ui/card';
	import * as Table from '$lib/components/ui/table';
	import { Button } from '$lib/components/ui/button';
	import { Separator } from '$lib/components/ui/separator';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	/** The §16.5 error envelope codes, as documented by the spec. */
	const errorCodes = [
		{
			status: '400',
			code: 'bad_request',
			when: 'The request body — or an opaque cursor — could not be parsed.'
		},
		{
			status: '401',
			code: 'unauthorized',
			when: 'Missing, invalid, expired or revoked key. Every auth failure looks the same.'
		},
		{ status: '403', code: 'forbidden_scope', when: 'A read-only key attempted a write.' },
		{
			status: '404',
			code: 'not_found',
			when: 'The resource does not exist — or you have no access to it. The two are conflated.'
		},
		{
			status: '409',
			code: 'conflict',
			when: 'An Idempotency-Key was reused with a different body, or a retry is still in flight.'
		},
		{
			status: '422',
			code: 'validation_error',
			when: 'A rule failed. details.fieldErrors names the offending fields.'
		},
		{
			status: '429',
			code: 'rate_limited',
			when: 'Too many requests for this key. Back off for Retry-After seconds.'
		},
		{ status: '500', code: 'internal_error', when: 'Something broke on our side.' }
	];
</script>

<svelte:head>
	<title>API docs · Pay with me</title>
	<meta
		name="description"
		content="Read and write your Pay with me groups, transactions and balances from a script or an AI agent."
	/>
</svelte:head>

<div class="space-y-8">
	<header class="space-y-2">
		<h1 class="text-2xl font-semibold tracking-tight">API docs</h1>
		<p class="max-w-prose text-sm text-pretty text-muted-foreground">
			A REST/JSON API over your groups, transactions and balances — built for scripts and AI agents
			acting on your behalf. Everything lives under
			<code class="rounded bg-muted px-1 py-0.5 font-mono text-xs">{data.basePath}</code>, and every
			request carries an API key you mint yourself.
		</p>
		<p class="max-w-prose text-sm text-pretty text-muted-foreground">
			This page is the quickstart and the conventions. Every endpoint's exact request and response
			shape lives in the <strong class="font-medium text-foreground">OpenAPI spec</strong> — the single
			source of truth, linked at the bottom.
		</p>
	</header>

	<!-- ── Quickstart: mint a key → read → write ──────────────────────────────── -->
	<Card.Root>
		<Card.Header>
			<Card.Title>Quickstart</Card.Title>
			<Card.Description>
				From nothing to a recorded expense in three steps. The examples use
				<code class="font-mono text-xs">${data.keyEnvVar}</code> — export your key into it first, and
				never paste a key inline.
			</Card.Description>
		</Card.Header>

		<Card.Content class="space-y-6">
			<section class="space-y-2">
				<h2 class="text-base font-medium">1. Mint a key</h2>
				<p class="max-w-prose text-sm text-pretty text-muted-foreground">
					Create one in Settings → API keys. Pick <strong class="font-medium text-foreground"
						>read-only</strong
					>
					unless the agent genuinely needs to record money; a read key gets a
					<code class="font-mono text-xs">403</code> on every write. The full key is shown
					<strong class="font-medium text-foreground">once</strong>, at creation — copy it then. A
					key sees exactly the groups you see.
				</p>
				<Button href={resolve('/settings/api-keys/new')} size="sm">Create an API key</Button>
			</section>

			<Separator />

			<section class="space-y-2">
				<h2 class="text-base font-medium">2. Read: list your groups</h2>
				<p class="max-w-prose text-sm text-pretty text-muted-foreground">
					Every request authenticates with <code class="font-mono text-xs"
						>Authorization: Bearer &lt;key&gt;</code
					>. Start here — you need a group id (and its
					<code class="font-mono text-xs">settlementCurrency</code>) for everything else.
				</p>
				<pre class="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs"><code
						>{data.quickstart.readCommand}</code
					></pre>
				<p class="text-xs text-muted-foreground">
					Response — <code class="font-mono">200 OK</code>:
				</p>
				<pre class="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs"><code
						>{data.quickstart.groupsResponse}</code
					></pre>
				<p class="max-w-prose text-sm text-pretty text-muted-foreground">
					Then <code class="font-mono text-xs">GET {data.basePath}/groups/&lt;gid&gt;/members</code>
					for the member ids every payer, beneficiary and balance refers to.
				</p>
			</section>

			<Separator />

			<section class="space-y-2">
				<h2 class="text-base font-medium">3. Write: record a transaction</h2>
				<p class="max-w-prose text-sm text-pretty text-muted-foreground">
					฿900.00 of ramen, paid by Ada, split evenly with Grace. Note the three things that trip
					agents up: money is <strong class="font-medium text-foreground"
						>integer minor units</strong
					>
					(<code class="font-mono text-xs">90000</code>, not
					<code class="font-mono text-xs">900.0</code>), the payers' amounts must add up to
					<code class="font-mono text-xs">amountTotal</code>, and you supply
					<code class="font-mono text-xs">amountTotalSettlement</code> yourself (trivially equal
					here, because the entry currency <em>is</em> the group's settlement currency at rate
					<code class="font-mono text-xs">"1"</code>).
				</p>
				<pre class="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs"><code
						>{data.quickstart.writeCommand}</code
					></pre>
				<p class="text-xs text-muted-foreground">
					Response — <code class="font-mono">201 Created</code>. The same shape every read serves;
					<code class="font-mono">shares</code> is the resolved per-member owed, in the settlement currency:
				</p>
				<pre class="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs"><code
						>{data.quickstart.createResponse}</code
					></pre>
				<p class="text-xs text-muted-foreground">
					And when a rule fails — <code class="font-mono">422 Unprocessable Content</code>. Every
					error looks like this;
					<code class="font-mono">details.fieldErrors</code> tells an agent exactly what to fix:
				</p>
				<pre class="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs"><code
						>{data.quickstart.errorResponse}</code
					></pre>
			</section>
		</Card.Content>
	</Card.Root>

	<!-- ── Conventions (PLAN §16.3–§16.7) ─────────────────────────────────────── -->
	<Card.Root>
		<Card.Header>
			<Card.Title>Conventions</Card.Title>
			<Card.Description>The rules that hold across every endpoint.</Card.Description>
		</Card.Header>

		<Card.Content class="space-y-6">
			<section class="space-y-2">
				<h2 class="text-base font-medium">Versioning &amp; transport</h2>
				<ul class="max-w-prose list-disc space-y-1 pl-5 text-sm text-pretty text-muted-foreground">
					<li>
						The version is in the path: <code class="font-mono text-xs">{data.basePath}/…</code>. A
						future v2 will live beside it — no header or media-type versioning, and no unversioned
						alias.
					</li>
					<li>
						JSON only, in and out. A body that isn't valid JSON is a
						<code class="font-mono text-xs">400</code>. No trailing slashes.
					</li>
					<li>
						CORS is closed — there are no <code class="font-mono text-xs">Access-Control-*</code>
						headers. This is a server-to-server API; calling it from a browser page will not work.
					</li>
					<li>
						Groups, members and invites are <strong class="font-medium text-foreground">not</strong> manageable
						through the API in v1. Use the web app.
					</li>
				</ul>
			</section>

			<section class="space-y-2">
				<h2 class="text-base font-medium">Keys &amp; scopes</h2>
				<ul class="max-w-prose list-disc space-y-1 pl-5 text-sm text-pretty text-muted-foreground">
					<li>
						A key carries one scope: <code class="font-mono text-xs">read</code> or
						<code class="font-mono text-xs">write</code>. A write key can also read.
					</li>
					<li>
						A read key hitting a write endpoint gets
						<code class="font-mono text-xs">403 forbidden_scope</code> — it never gets as far as touching
						money.
					</li>
					<li>
						Actions are audited as <em>you</em>, with the key recorded as the route they came in
						through. Revoking a key stops it instantly; it does not undo what it did.
					</li>
				</ul>
			</section>

			<section class="space-y-2">
				<h2 class="text-base font-medium">Money</h2>
				<p class="max-w-prose text-sm text-pretty text-muted-foreground">
					Every monetary value on the wire is self-describing:
					<code class="font-mono text-xs">{'{ "amount": 45000, "currency": "THB" }'}</code>.
					<code class="font-mono text-xs">amount</code> is an
					<strong class="font-medium text-foreground">integer in minor units</strong> — never a
					float, never a formatted string. ฿450.00 is <code class="font-mono text-xs">45000</code>;
					¥3600 (a zero-exponent currency) is <code class="font-mono text-xs">3600</code>. Fetch
					each currency's exponent and symbol once from
					<code class="font-mono text-xs">GET {data.basePath}/currencies</code>.
				</p>
				<p class="max-w-prose text-sm text-pretty text-muted-foreground">
					A group can also define a currency of its own — an unlisted national one, or a unit that
					was never money. A transaction entered in one reports that group's short code (say
					<code class="font-mono text-xs">BEER</code>) as its
					<code class="font-mono text-xs">currency</code>. Such a code is
					<strong class="font-medium text-foreground">meaningful only inside that group</strong>:
					two groups may use the same one for unrelated units, and
					<code class="font-mono text-xs">GET {data.basePath}/currencies</code> — a global table —
					does not list it. To see one — and to get its exponent and symbol — ask the group:
					<code class="font-mono text-xs">GET {data.basePath}/groups/{'{gid}'}/currencies</code>
					returns the listed currencies plus that group's own. Settlement amounts are never affected;
					they are always one of the listed currencies.
				</p>
				<p class="max-w-prose text-sm text-pretty text-muted-foreground">
					The short code is the vocabulary in
					<strong class="font-medium text-foreground">both directions</strong>: the
					<code class="font-mono text-xs">currency</code> a transaction reports is the one you send
					back when you write it, so a transaction entered in a group-defined currency round-trips
					through
					<code class="font-mono text-xs">PUT</code> unchanged. Codes are resolved against the group
					in the path, so a code belonging to another group is refused exactly like an unknown one —
					a
					<code class="font-mono text-xs">422</code>. The internal identifier such a currency is
					stored under is never disclosed, and is not accepted either.
				</p>
				<p class="max-w-prose text-sm text-pretty text-muted-foreground">
					Each group has a <strong class="font-medium text-foreground">settlement currency</strong>:
					balances and shares are always in it. A transaction may be entered in another currency, in
					which case you must supply the conversion — the exchange rate as a
					<em>string</em> (up to 6 decimal places, so no float ever touches the math), and the converted
					total. The server re-checks it exactly:
				</p>
				<pre class="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs"><code
						>amountTotalSettlement
  == round_half_up(
       amountTotal × exchangeRate × 10^(exp_settlement − exp_currency)
     )

// exp_x = the currency's `exponent` from GET {data.basePath}/currencies
// e.g. ¥3600 (JPY, exp 0) @ 0.244 → THB (exp 2):
//      round_half_up(3600 × 0.244 × 10^2) = 87840  // ฿878.40</code
					></pre>
				<p class="max-w-prose text-sm text-pretty text-muted-foreground">
					A mismatch is a <code class="font-mono text-xs">422</code> naming
					<code class="font-mono text-xs">amountTotalSettlement</code>. Same-currency is the trivial
					case: rate <code class="font-mono text-xs">"1"</code>, and
					<code class="font-mono text-xs">amountTotalSettlement == amountTotal</code>.
				</p>
			</section>

			<section class="space-y-2">
				<h2 class="text-base font-medium">Errors</h2>
				<p class="max-w-prose text-sm text-pretty text-muted-foreground">
					Every error is <code class="font-mono text-xs"
						>{'{ "error": { "code", "message", "details"? } }'}</code
					>. Branch on <code class="font-mono text-xs">code</code> — it is the stable contract;
					<code class="font-mono text-xs">message</code> is for humans and may change.
				</p>
				<div class="overflow-x-auto">
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head class="w-16">Status</Table.Head>
								<Table.Head>Code</Table.Head>
								<Table.Head>When</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each errorCodes as row (row.code)}
								<Table.Row>
									<Table.Cell class="font-mono text-xs">{row.status}</Table.Cell>
									<Table.Cell class="font-mono text-xs whitespace-nowrap">{row.code}</Table.Cell>
									<Table.Cell class="text-sm text-muted-foreground">{row.when}</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
			</section>

			<section class="space-y-2">
				<h2 class="text-base font-medium">Idempotency &amp; write safety</h2>
				<ul class="max-w-prose list-disc space-y-1 pl-5 text-sm text-pretty text-muted-foreground">
					<li>
						Send an <code class="font-mono text-xs">Idempotency-Key</code> header on creates (<code
							class="font-mono text-xs">POST …/transactions</code
						>
						and
						<code class="font-mono text-xs">POST …/settle-up</code>). It is optional but
						<strong class="font-medium text-foreground">strongly recommended</strong>: without it a
						retry after a network timeout can record the same expense twice.
					</li>
					<li>
						The key is yours to choose, remembered for 24 hours, scoped to your API key. Same key +
						same body replays the original response — no second transaction, no second audit entry.
						Same key + a <em>different</em> body is a
						<code class="font-mono text-xs">409</code>, as is a retry that races the original.
					</li>
					<li>
						Updates are <code class="font-mono text-xs">PUT</code>, not
						<code class="font-mono text-xs">PATCH</code>: the body is the
						<strong class="font-medium text-foreground">complete</strong> transaction, and it replaces
						what was there.
					</li>
					<li>
						Concurrency is last-write-wins — there is no version or
						<code class="font-mono text-xs">If-Match</code> in v1. A
						<code class="font-mono text-xs">PUT</code> built from a stale read silently reverts anything
						changed in between, so read immediately before you write.
					</li>
					<li>
						Delete is a <em>soft</em> delete: the transaction stops counting towards balances but stays
						fetchable and can be restored. Deleting an already-deleted transaction (or restoring a live
						one) succeeds and changes nothing.
					</li>
				</ul>
			</section>

			<section class="space-y-2">
				<h2 class="text-base font-medium">Pagination</h2>
				<p class="max-w-prose text-sm text-pretty text-muted-foreground">
					Only <code class="font-mono text-xs">GET …/transactions</code> paginates — newest first,
					up to <code class="font-mono text-xs">limit</code> rows (default 50, max 100). Pass the
					response's <code class="font-mono text-xs">nextCursor</code> back as
					<code class="font-mono text-xs">cursor</code> for the next page;
					<code class="font-mono text-xs">null</code> means you have reached the end. The cursor is opaque
					— don't build or parse one. Every other collection returns in full.
				</p>
			</section>

			<section class="space-y-2">
				<h2 class="text-base font-medium">Rate limits</h2>
				<p class="max-w-prose text-sm text-pretty text-muted-foreground">
					Per key, per 60-second window: <strong class="font-medium text-foreground"
						>100 reads</strong
					>
					and <strong class="font-medium text-foreground">20 writes</strong>, counted independently,
					behind a combined 150-request backstop. Over the limit you get
					<code class="font-mono text-xs">429 rate_limited</code> with a
					<code class="font-mono text-xs">Retry-After</code> header (and the same numbers in
					<code class="font-mono text-xs">details</code>) — wait that many seconds and retry.
				</p>
			</section>
		</Card.Content>
	</Card.Root>

	<!-- ── The raw spec (the single source of truth) ──────────────────────────── -->
	<Card.Root>
		<Card.Header>
			<Card.Title>The full reference</Card.Title>
			<Card.Description>
				Every endpoint, every field, every example — an OpenAPI 3.1 spec you can hand straight to an
				agent, a client generator, or an HTTP client. This is the contract; the page you're reading
				is only the tour.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-2 sm:flex-row">
			<!-- Static assets, not SvelteKit routes — `resolve()` cannot type them. -->
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
			<Button href={data.specYamlPath}>OpenAPI spec (YAML)</Button>
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
			<Button variant="outline" href={data.specJsonPath}>OpenAPI spec (JSON)</Button>
		</Card.Content>
	</Card.Root>
</div>
