/**
 * Word-pair object ids. The session's counter (next_obj) picks the pair, so an id is reused only if the counter is.
 * There is no randomness and no port: the same counter gives the same id on every replay and in every host.
 *
 * The lists, their order and STRIDE are frozen: changing any of them gives old counters other pairs, which could reuse
 * an id that a deleted object once held. Adding a word needs a new mapping, not an edit here.
 */
import { at } from "../../invariant/index.ts";

const words = (s: string): readonly string[] => s.trim().split(/\s+/);

/** No colours and no foods, so that an id can't contradict an object's label. @internal */
export const ADJECTIVES = words(`
  able acute adept aerial agile airy alert alive alpine amiable ample amused ancient apt arctic ardent artful
  astute avid awake aware balmy bold boreal brave breezy bright brisk broad busy calm candid canny careful
  caring casual certain cheery chipper civil classy clean clear clever close cloudy coastal comfy cosmic cosy
  crafty curious dapper daring dashing deft devoted direct distant docile dreamy driven dutiful eager early
  earnest easy elated elder elegant elfin epic equal exact expert fabled fair famous fancy fast festive fine
  firm first fleet floral fluent fluffy fond formal frank free frosty gallant genial gentle giddy gifted
  glacial glad gleeful global glossy good grand grassy great gusty handy happy hardy helpful heroic hidden
  hilly honest hopeful humble ideal inland inner jaunty jolly jovial joyful joyous keen kind kindly leafy
  lithe lively local lofty loyal lucid lucky lunar major mellow merry mighty mild mindful misty modern modest
  mossy mystic neat nice nimble noble nomadic normal novel oceanic open orderly ornate outer patient perky
  plucky plush poised polar polite primal prime prompt proper proud prudent quaint quick quiet rainy rapid
  ready regal relaxed robust roomy royal rugged rural rustic safe savvy scenic secure serene shady shiny
  silent silky simple sincere sleek smart smiling smooth snappy snowy snug sober social solar solid sound spry
  stable stately steady stellar sturdy subtle sunny super supple sure svelte swift sylvan tactful tidal tidy
  timely tropic true trusty upbeat upland urbane valiant vast vernal vibrant vital vivid warm wary wavy
  welcome wild windy winsome wise witty wooded woolly worthy zany zealous zippy
`);
/** Wild animals, trees and landforms, not things people catalogue. No foods. @internal */
export const NOUNS = words(`
  acacia adder alder alpaca atoll aurora avocet axolotl badger banyan baobab bay bayou beaver beech beetle
  birch bison bluff bog breeze brook bunting butte cairn caldera canyon caracal caribou cascade cavern cedar
  chamois cheetah cicada cirque civet cliff coati cobra comet condor coot copse cougar cove coyote crag creek
  curlew cypress dale delta dingo dipper dolphin drumlin dugong dune dunlin egret eland elk elm emu ermine
  esker estuary falcon fen ferret finch fir firefly fjord fossa fox gale gannet gazelle gecko geyser gibbon
  glacier glen gopher gorge gorilla grebe grotto grove gull gully harrier heath hemlock heron hollow hoopoe
  hornet hyena ibex ibis iceberg iguana impala inlet isthmus jackal jaguar jay juniper kestrel kinglet knoll
  koala kudu lagoon larch lark lemming lemur leopard limpet linden linnet lion llama loon lynx macaw magpie
  mamba manatee manta mantis marlin marmot marsh marten martin massif meadow merlin mesa meteor mink minnow
  mistral monsoon moor moose moraine moth narwhal nebula newt numbat oak oasis ocelot okapi orca oriole oryx
  osprey otter pampas panda panther peak pelican petrel pika pipit plateau plover poplar possum prairie puffin
  pulsar puma python quasar quokka raccoon rapids raven ravine reef rhea ridge rill robin rook rowan savanna
  scree seal sequoia serval shoal shrew sierra siskin skink sloth sparrow spruce squall steppe stoat stork
  strait summit swale taiga tamarin tanager tapir tarn tarpon tarsier tempest tern thicket thrush tiger toad
  toucan towhee tundra urchin vale valley viper vireo volcano vole wallaby walrus wapiti warbler wasp waxwing
  weald weasel wetland willow wolf wombat wren yak yew zephyr
`);

const SIZE = 256;
/** Pairs in all. Counter values 1 to PAIRS name a pair; above that, ids go back to "o<n>". @internal */
export const PAIRS = SIZE * SIZE;
/** Odd, so coprime with PAIRS and n * STRIDE % PAIRS is a bijection. About PAIRS / phi, so neighbours look unrelated. */
const STRIDE = 40503;
/** STRIDE * INVERSE % PAIRS is 1. */
const INVERSE = 30599;

/**
 * The id for counter value `n` (1 or more). Past the last pair it is "o<n>". Nothing fails or wraps: the counter is
 * above every legacy id by then, so "o<n>" is unused too.
 */
export const objectName = (n: number): string => {
  if (n > PAIRS) return `o${n}`;
  const pair = (n * STRIDE) % PAIRS;
  return `${at(ADJECTIVES, Math.floor(pair / SIZE))}-${at(NOUNS, pair % SIZE)}`;
};

const adjectiveAt: ReadonlyMap<string, number> = new Map(ADJECTIVES.map((w, k) => [w, k]));
const nounAt: ReadonlyMap<string, number> = new Map(NOUNS.map((w, k) => [w, k]));

/** The counter value that gives `id`: objectName's inverse. Null for "x" and for a pair not from the lists. */
export const counterOf = (id: string): number | null => {
  const legacy = /^o(\d+)$/.exec(id);
  if (legacy) return Number(legacy[1]);
  const [adjective = "", noun = ""] = id.split("-");
  const a = adjectiveAt.get(adjective);
  const b = nounAt.get(noun);
  if (a === undefined || b === undefined) return null;
  // counter value PAIRS gives pair 0
  return ((a * SIZE + b) * INVERSE) % PAIRS || PAIRS;
};
