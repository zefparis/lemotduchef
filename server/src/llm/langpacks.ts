import type { ReplyLang } from './langdetect.js';

// Référentiel par langue : salutation d'ouverture, forme d'adresse, formules
// interdites et motifs des règles — l'équivalent des constantes françaises
// de rules.ts, adapté langue par langue. Le français reste géré par
// rules.ts/checkReply ; ici : en, af, de, nl, es, it.

export interface LangPack {
  // Mot d'ouverture obligatoire (regex posée sur le texte normalisé).
  greeting: RegExp;
  greetingWord: string;                       // ex. 'Hello'
  informal: RegExp | null;                    // tutoiement → interdit si address_form='vous'
  forbidden: RegExp;                          // juridique / accusation de mensonge
  apology: RegExp;                            // excuses (comptées)
  banned: string[];                           // formules interdites (texte normalisé)
  impatience: RegExp;                         // client impatient / de mauvaise foi
  internalClaims: Array<[RegExp, string]>;    // procédures internes inventées
  surprise: RegExp;                           // « surpris » réservé aux contextes contestés
  analysisLeak: RegExp;                       // fuite de la consigne interne
  noDetail: RegExp;                           // « l'avis ne donne pas de détail »
  warned: RegExp;                             // faits affirmés non fournis
  factsHint: RegExp;                          // indice que le fait est fourni quelque part
  firstSentFact: RegExp;                      // explication d'attente en 1re phrase
  blame: RegExp;                              // reproche au client
  priceWords: RegExp;                         // mots « prix » pour la règle prix affichés
  returnInvite: RegExp;                       // invitation à revenir (fin d'avis négatif)
  commercialGesture: RegExp;                  // remise/cadeau interdits
  contactInvite: RegExp;                      // invitation à un contact privé
  admission: RegExp;                          // reconnaissance de responsabilité (santé)
  closingFormulas: RegExp;                    // formules de politesse détectées en signature
  triadAnd: string;                           // mot de coordination pour la triplette
  clauseMark: RegExp;                         // sujets/auxiliaires disqualifiant la triplette
  reservation: RegExp;                        // invitation à réserver (impérative, pas le nom « réservation »)
}

const en: LangPack = {
  greeting: /^(dear |hello|hi|good (morning|afternoon|evening)|thank you)/i,
  greetingWord: 'Hello',
  informal: null, // l'anglais n'a pas de distinction tu/vous
  forbidden: /\b(liar|lying|lied|defamation|defamatory|court|lawsuit|sue|lawyer|attorney|legal action|prosecute|complaint filed|bailiff|police)\b/i,
  apology: /(\bwe('| a)?re (so |truly |very |really |extremely )?(sorry|apologetic)|we (offer|extend|sincerely offer) our (sincere |deepest )?(apologies|regrets)|our apologies|we apologize|please accept our (sincere |deepest )?(apologies|regrets)|i am (so |truly |very |really )?(sorry|apologetic)|i('| a)?m sorry|i regret)/gi,
  banned: [
    'sincerely sorry', 'we take your feedback seriously', 'your feedback matters',
    'we take your review seriously', 'we are deeply sorry', 'devastated to hear',
    'your feelings', 'this feeling', 'we would like to clarify', 'knowingly',
    'in full transparency', 'unacceptable', 'do not hesitate', "don't hesitate",
    'thank you for taking the time', 'thank you for sharing your experience',
    'thank you for sharing', 'we value your feedback', 'we appreciate your feedback',
    'thank you for your valuable feedback', 'thanks for taking the time',
    'we hear your disappointment', 'we understand your disappointment', 'rest assured',
  ],
  impatience: /(impatient|impatience|bad faith|dishonest|exaggerat|you are exaggerating|not truthful)/i,
  internalClaims: [
    [/\brecords?\b|\bregisters?\b|\blogbooks?\b/i, 'registre'],
    [/\binspections?\b|\bchecks? (are |is )?(regularly )?(carried|done|performed)/i, 'contrôle'],
    [/\bprocedures?\b|\bprotocols?\b/i, 'procédure'],
    [/\bwe are working on\b|\bwe work (hard )?(every day )?to\b/i, 'nous travaillons à'],
    [/\bwe (have )?(reviewed|are reviewing|revisited)\b/i, 'nous revoyons'],
    [/\bwe (have )?(put|implemented|set up)\b.{0,20}(in place|measures|changes)/i, 'nous mettons en place'],
  ],
  surprise: /\bsurpris(ed|ing)|\bsurpris(e|es)\b/i,
  analysisLeak: /\b(nature|category|classification|type|kind) of (the |your |this )?(complaint|criticism|review)\b|your (comment|review|feedback|note|message) (is about|concerns|focuses on|relates to)/i,
  noDetail: /(no details?|does not (give|provide|leave) (any )?details?|without (any )?details?|no specifics?|lacks? (of )?details?|empty (review|comment)|review (is )?empty|no explanation)/i,
  warned: /(you were (warned|informed|told|advised)|as (agreed|discussed|mentioned|planned|announced)|(informed|told|advised|warned)[^.]{0,30}(at|on|before) (your |the )?(arrival|entrance|ordering|order))/i,
  factsHint: /(warned|informed|told|advised|announced|mentioned|agreed|planned)/i,
  firstSentFact: /(warned|informed|told|advised|announced|fully booked|full house|complete|packed|was full|running at full)/i,
  blame: /(you were (warned|told|informed|advised)|we (told|informed|warned|advised) you|as (i|we) (told|said|mentioned) (you )?(before|earlier)|like we said|as agreed upon)/i,
  priceWords: /(price|prices|pricing|cost|bill|check|charged|rand|euro|€|R\s?\d)/i,
  returnInvite: /(come back|return|visit (us )?again|see you again|second chance|another chance|next (visit|time)|welcome you|drop (in|by)|join us|hope to (see|welcome)|look forward to|anytime|soon again|swing by)/i,
  commercialGesture: /(refund|free|complimentar|discount|voucher|gift|on the house|compensat|offer you (a|free)|waive)/i,
  contactInvite: /(contact|reach (us|out)|call|write|e-?mail|phone|in private|directly|talk (to|with)|speak (to|with)|get in touch)/i,
  admission: /\b(our fault|our responsibility|we (are|take) (fully )?(responsible|accountable)|we (admit|acknowledge) (our |that )?(it was|fault|responsibility)|it was our fault|made you (sick|ill)|food poisoning (caused|from|at))/i,
  closingFormulas: /kind regards|best regards|warm regards|sincerely|yours (sincerely|truly)|regards|cheers|the team|all the best/i,
  triadAnd: ' and ',
  clauseMark: /\b(i|you|he|she|it|we|they|this|that|there|who|when|as|since|because|which|where|if|but|so|nor|for|is|are|was|were|am|be|been|being|will|would|shall|should|must|can|could|may|might|do|does|did|done|have|has|had|come|go|let|hope|wish|invite|look|see|feel|stay|remain|seem|seems|deserve|expect|aim|strive)\b/i,
  reservation: /\b(book|booking) (ahead|a table|your table|early)|book a table|reserve a table|make a (booking|reservation)|secure your (table|spot)|booking ahead/i,
};

const af: LangPack = {
  greeting: /^(goeie(dag|dag|more|middag|aand)|hallo|dankie|beste)/i,
  greetingWord: 'Goeiedag',
  informal: /\b(jy|jou|joune)\b/i, // formel : 'u'
  forbidden: /\b(leuenaar|lieg|laster|lasterlik|hof|hofsaak|prokureur|regverdig|regstappe|aanklag|polisie|geregtelik|geding)\b/i,
  apology: /(\bons is (so |regtig |baie )?(jammer|spyt)|ons vra (om )?(verskoning|om verskoning)|ons (bied|doen) (onregte )?(verskoning|spyt)|ek is (so |regtig |baie )?jammer|verskoning|spytig)/gi,
  banned: [
    'regtig jammer', 'ons neem jou terugvoer ernstig', 'jou terugvoer tel',
    'ons is diep jammer', 'jou gevoel', 'volle deursigtigheid', 'mielie',
    'moenie huiwer', 'dankie dat jy die tyd geneem', 'dankie dat u die tyd geneem',
    'dankie vir die deel van u ervaring', 'dankie vir die deel van jou ervaring',
    'ons waardeer jou terugvoer', 'ons waardeer u terugvoer',
    'dankie vir u waardevolle terugvoer', 'ons hoor jou teleurstelling',
    'ons verstaan jou teleurstelling', 'wees verseker',
  ],
  impatience: /(ongeduld|slegte trou|oneerlik|oordryf|jy oordryf)/i,
  internalClaims: [
    [/\bregisters?\b|\bnotas?\b/i, 'registre'],
    [/\binspeksies?\b|\bkontroles?\b/i, 'contrôle'],
    [/\bprosedures?\b|\bprotokolle?\b/i, 'procédure'],
    [/\bons werk aan\b/i, 'nous travaillons à'],
    [/\bons het (hiersien|hersien)\b|\bons is besig om\b/i, 'nous revoyons'],
    [/\bons het in plek\b|\bons implementeer\b/i, 'nous mettons en place'],
  ],
  surprise: /\bverras|verrassing\b/i,
  analysisLeak: /\b(natuur|kategorie|tipe) van (die |jou |hierdie )?(kritiek|resensie|klagte)\b|jou (resensie|terugvoer|opmerking|boodskap) (gaan oor|handel oor|fokus op)/i,
  noDetail: /(geen besonderhede|geen detail|sonder (enige )?detail|sonder besonderhede|geen verduideliking|leë (resensie|opmerking))/i,
  warned: /(jy was (verwittig|ingelig|vertel)|soos (ooreengekom|bespreek|genoem|aangekondig)|(ingelig|vertel)[^.]{0,30}(met|by|voor) (jou |die )?(aankoms|bestelling))/i,
  factsHint: /(verwittig|ingelig|vertel|aangekondig|genoem|ooreengekom|bespreek|beplan)/i,
  firstSentFact: /(verwittig|ingelig|aangekondig|volle huis|vol bespreek|was vol|volle besetting)/i,
  blame: /(jy was (verwittig|vertel|ingelig)|ons het (jou )?(vertel|ingelig|verwittig)|soos (ek|ons) (jou )?(gesê|genoem|vertel) het|soos ooreengekom)/i,
  priceWords: /(prys|pryse|koste|rekening|rand|R\s?\d)/i,
  returnInvite: /(kom (gerus |weer |terug |verby|by ons)|besoek (ons )?weer|sien (jou|u) weer|tweede kans|nog 'n kans|volgende (besoek|keer)|verwelkom|welkom|kom kuier|sien uit|uit daarna|ontmoet|terugkeer|terugkom|enige tyd|weer hier|weer te sien|weer te ontmoet)/i,
  commercialGesture: /(terugbetaling|gratis|afslag|geskenk|koepon|vergoeding|vergoed|bied jou (gratis|'n)|korting)/i,
  contactInvite: /(kontak|bereik|bel|skryf|e-?pos|foon|in privaat|direk|praat (met|saam)|in verbinding)/i,
  admission: /\b(ons fout|ons verantwoordelikheid|ons is verantwoordelik|ons erken|ons het jou (siek|ongesteld) gemaak|voedselvergiftiging)/i,
  closingFormulas: /vriendelike groete|beste wense|groete|die span|als die beste/i,
  triadAnd: ' en ',
  clauseMark: /\b(ek|jy|hy|sy|dit|ons|hulle|hierdie|daardie|daar|wie|wanneer|as|sedert|omdat|wat|waar|as|maar|so|nog|vir|is|was|word|sal|sou|moet|kan|mag|doen|het|kom|gaan|laat|hoop|wens|genooi|kyk|sien|voel|bly|blyk|verdien|verwag|streef)\b/i,
  reservation: /bespreek (vooruit|vooraf|'n tafel|vroeër)|maak 'n bespreking|bespreking vooruit|reserveer 'n tafel|boek vooruit/i,
};

const de: LangPack = {
  greeting: /^(guten (tag|morgen|abend)|hallo|liebe|sehr geehrte|vielen dank)/i,
  greetingWord: 'Guten Tag',
  informal: /\b(du|dich|dir|dein|deine|deiner|deinem|deinen)\b/i, // formel : 'Sie'
  forbidden: /\b(lügner|lügen|lüge|verleumdung|verleumderisch|gericht|klage|anwalt|rechtsanwalt|rechtsweg|prozess|gerichtsvollzieher|polizei|strafanzeige|verklagen)\b/i,
  apology: /(\bwir (sind|tut uns|tut es)\b.{0,25}(leid|leid?)|es tut uns (sehr |wirklich |aufrichtig |unendlich )?leid|wir (bitten|bieten) (um |Ihnen unsere )?(entschuldigung|verzeihung)|unsere (aufrichtigen )?(entschuldigung|verzeihung)|wir entschuldigen uns|entschuldigen sie|verzeihen sie|ich (tut|tue) (es |das )?(sehr )?leid|ich bedauere)/gi,
  banned: [
    'aufrichtig leid', 'wir nehmen ihr feedback ernst', 'ihr feedback zählt',
    'wir bedauern zutiefst', 'ihr empfinden', 'in voller transparenz',
    'inakzeptabel', 'zögern sie nicht', 'vielen dank, dass sie sich die zeit',
    'danke, dass sie sich die zeit', 'vielen dank für das teilen',
    'danke für das teilen', 'wir schätzen ihr feedback',
    'vielen dank für ihr wertvolles feedback', 'wir danken ihnen für ihre erfahrung',
    'wir hören ihre enttäuschung', 'wir verstehen ihre enttäuschung',
    'seien sie versichert',
  ],
  impatience: /(ungeduld|böser absicht|unehrlich|übertreiben|sie übertreiben|übertrieben)/i,
  internalClaims: [
    [/\bregister\b|\baufzeichnungen\b|\bprotokolle?\b/i, 'registre'],
    [/\bkontrollen\b|\binspektionen\b|\büberprüf/i, 'contrôle'],
    [/\bverfahren\b|\brichtlinien\b/i, 'procédure'],
    [/\bwir arbeiten (daran|gerade)\b/i, 'nous travaillons à'],
    [/\bwir (haben )?(überarbeitet|überprüft|überdenken)\b/i, 'nous revoyons'],
    [/\bwir (haben )?(eingeführt|eingerichtet|umgesetzt)\b/i, 'nous mettons en place'],
  ],
  surprise: /\büberrasch|verwunder/i,
  analysisLeak: /\b(natur|kategorie|art) der (kritik|bewertung|beschwerde)\b|ihre (bewertung|rückmeldung|bemerkung|nachricht) (betrifft|behandelt|handelt von|bezieht sich auf)/i,
  noDetail: /(keine (details|einzelheiten)|ohne (jegliche |weitere )?details|keine angaben|keine erklärung|leere (bewertung|rezension)|nichtssagend)/i,
  warned: /(sie wurden (gewarnt|informiert|benachrichtigt)|wie (vereinbart|besprochen|erwähnt|angekündigt)|(informiert|benachrichtigt)[^.]{0,30}(bei|vor|nach) (ihrer |der )?(ankunft|bestellung|eingang))/i,
  factsHint: /(gewarnt|informiert|benachrichtigt|angekündigt|erwähnt|vereinbart|besprochen|geplant)/i,
  firstSentFact: /(gewarnt|informiert|angekündigt|komplett voll|volles haus|ausgebucht|komplett besetzt|am anschlag)/i,
  blame: /(sie wurden (gewarnt|informiert)|wir (haben sie )?(informiert|gewarnt|benachrichtigt)|wie (ich|wir) (ihnen )?(gesagt|erwähnt) (hatten|haben)|wie vereinbart)/i,
  priceWords: /(preis|preise|kosten|rechnung|euro|€|rand|R\s?\d)/i,
  returnInvite: /(kommen sie (gerne )?(wieder|zurück)|besuchen sie uns (wieder|erneut)|sehen wir sie wieder|zweite chance|weitere chance|nächsten (besuch|mal)|begrüßen|vorbeischauen|wir freuen uns|jederzeit|bald wieder|wiedersehen)/i,
  commercialGesture: /(rückerstattung|kostenlos|gratis|rabatt|gutschein|geschenk|entschädig|entschädigen|auf (uns|kosten des hauses)|erlassen)/i,
  contactInvite: /(kontakt|erreichen|anrufen|schreiben|e-?mail|telefon|privat|direkt|sprechen (mit|zu)|in verbindung|melden sie sich)/i,
  admission: /\b(unser(e)? schuld|unsere verantwortung|wir (sind|übernehmen) (die )?(verantwortlich|schuld)|wir (geben zu|erkennen an)|lebensmittelvergiftung|sie (wurden|sind) (bei uns )?krank)/i,
  closingFormulas: /freundliche grüße|mit freundlichen grüßen|beste grüße|herzliche grüße|viele grüße|das team|alles gute/i,
  triadAnd: ' und ',
  clauseMark: /\b(ich|du|er|sie|es|wir|ihr|sie|dies|das|dass|wer|wenn|als|da|weil|welch|wo|ob|aber|so|noch|für|ist|sind|war|waren|bin|bist|sein|wird|werde|wird|würde|muss|müssen|kann|können|darf|dürfen|soll|sollen|habe|haben|hat|hatte|hatten|komme|kommen|gehe|gehen|lassen|hoffen|wünschen|einladen|sehen|fühlen|bleiben|scheinen|verdienen|erwarten|streben)\b/i,
  reservation: /reservieren sie|einen tisch reservieren|buchen sie (einen|ihren) tisch|im voraus buchen|rechtzeitig buchen|reserviert (ihren )?tisch/i,
};

const nl: LangPack = {
  greeting: /^(goedendag|goede(morgen|middag|avond)|hallo|beste|dag|hartelijk dank)/i,
  greetingWord: 'Beste',
  informal: /\b(je|jij|jou|jouw|jezelf)\b/i, // formel : 'u'
  forbidden: /\b(leugenaar|liegen|leugen|smaad|laster|lasterlijk|rechtbank|rechtszaak|advocaat|juridisch|rechtsstappen|proces|deurwaarder|politie|aangifte|vervolgen)\b/i,
  apology: /(\bhet spijt ons (zeer |vreselijk |oprecht |vriendelijk )?|wij (bieden|betuigen|vragen) (onze )?(oprechte )?(excuses|verontschuldiging)|onze (oprechte )?excuses|wij verontschuldigen ons|excuseer|vergeef (ons |u )?(alstublieft)|ik vind het (erg |vreselijk )?(spijtig|vervelend)|ik betreur)/gi,
  banned: [
    'oprecht spijt', 'wij nemen uw feedback serieus', 'uw feedback telt',
    'wij zijn diep bedroefd', 'uw gevoel', 'in volledige transparantie',
    'onaanvaardbaar', 'aarzel niet', 'bedankt dat u de tijd nam',
    'bedankt voor het delen van uw ervaring', 'bedankt voor het delen',
    'we waarderen uw feedback', 'wij waarderen uw feedback',
    'bedankt voor uw waardevolle feedback',
    'wij horen uw teleurstelling', 'wij begrijpen uw teleurstelling',
    'wees gerust',
  ],
  impatience: /(ongeduld|kwaadwillig|oneerlijk|overdrijft|u overdrijft|overdreven)/i,
  internalClaims: [
    [/\bregisters?\b|\bnotities?\b/i, 'registre'],
    [/\binspecties?\b|\bcontroles?\b/i, 'contrôle'],
    [/\bprocedures?\b|\bprotocollen\b/i, 'procédure'],
    [/\bwe werken (eraan|hard)\b/i, 'nous travaillons à'],
    [/\bwe (hebben )?(herzien|herziet|nagemeten|heroverwogen)\b/i, 'nous revoyons'],
    [/\bwe (hebben )?(ingevoerd|geïmplementeerd|ingesteld)\b/i, 'nous mettons en place'],
  ],
  surprise: /\bverrast|verrassing\b/i,
  analysisLeak: /\b(natuur|categorie|type|soort) van (de |uw |deze )?(kritiek|recensie|klacht)\b|uw (recensie|feedback|opmerking|bericht) (gaat over|betreft|richt zich op|heeft betrekking)/i,
  noDetail: /(geen (details|specificaties)|zonder (enige )?(details|specificaties)|geen verklaring|lege (recensie|opmerking)|inhoudsloos)/i,
  warned: /(u werd (gewaarschuwd|geïnformeerd|verwittigd)|zoals (afgesproken|besproken|vermeld|aangekondigd)|(geïnformeerd|verwittigd)[^.]{0,30}(bij|voor|na) (uw |de )?(aankomst|bestelling|binnenkomst))/i,
  factsHint: /(gewaarschuwd|geïnformeerd|verwittigd|aangekondigd|vermeld|afgesproken|besproken|gepland)/i,
  firstSentFact: /(gewaarschuwd|geïnformeerd|aangekondigd|vol huis|volle zaal|volledig vol|was vol|volgeboekt)/i,
  blame: /(u werd (gewaarschuwd|verwittigd|geïnformeerd)|wij (hebben u )?(gewaarschuwd|verwittigd|geïnformeerd)|zoals (ik|we|wij) (u )?(zei|zeiden|vermeld|verteld) (had|hadden)|zoals afgesproken)/i,
  priceWords: /(prijs|prijzen|kosten|rekening|euro|€|rand|R\s?\d)/i,
  returnInvite: /(kom (weer |graag )?(terug|langs)|bezoek ons (weer|opnieuw)|zien we u (weer|terug)|tweede kans|nieuwe kans|volgende (bezoek|keer)|verwelkomen|langskomen|we zien uit|altijd welkom|graag weer|tot ziens)/i,
  commercialGesture: /(terugbetaling|gratis|korting|tegoedbon|cadeau|compensatie|vergoed|op kosten van het huis|bieden u (gratis|een)|kwijtschelden)/i,
  contactInvite: /(contact|bereik|bel|schrijf|e-?mail|telefoon|privé|direct|spreek (met|tot)|neem contact|in verbinding|app)/i,
  admission: /\b(ons(e)? schuld|onze verantwoordelijkheid|wij (zijn|nemen) (de )?(verantwoordelijk|schuld)|wij (geven toe|erkennen)|voedselvergiftiging|u werd (bij ons )?ziek)/i,
  closingFormulas: /vriendelijke groeten|met vriendelijke groet|beste groeten|hartelijke groeten|het team|alle goeds/i,
  triadAnd: ' en ',
  clauseMark: /\b(ik|je|hij|zij|het|wij|jullie|zij|dit|dat|wie|wanneer|als|omdat|welk|waar|of|maar|dus|nog|voor|is|zijn|was|waren|ben|bent|wordt|worden|zal|zullen|zou|zouden|moet|moeten|kan|kunnen|mag|mogen|doe|doen|heb|hebben|heeft|had|hadden|kom|komen|ga|gaan|laat|laten|hoop|hopen|wens|wensen|nodig|nodigen|zie|zien|voel|voelen|blijf|blijven|lijkt|lijken|verdien|verdienen|verwacht|verwachten|streef|streven)\b/i,
  reservation: /reserveer (een|uw) tafel|reserveren van tevoren|boek (een|uw) tafel|vooraf reserveren|van tevoren boeken|reserveer vooraf/i,
};

const es: LangPack = {
  greeting: /^(hola|buenos (días|tardes|noches)|buen día|estimado|estimada|muchas gracias)/i,
  greetingWord: 'Hola',
  informal: /\b(tú|te|tu|tus|ti|contigo|vosotros)\b/i, // formel : 'usted'
  forbidden: /\b(mentiroso|mentirosa|mentira|miente|difamación|difamatorio|tribunal|demanda|abogado|vía judicial|proceso|denuncia|policía|juicio|demandar|acción legal)\b/i,
  apology: /(\b(sentimos|lamentamos) (mucho |muchísimo |sinceramente |profundamente )?|lo sentimos|le pedimos (mil |nuestras más sinceras )?(disculpas|perdón)|nuestras (más sinceras )?(disculpas|disculpa)|nos disculpamos|perdone|perdón|disculpe|me disculpo|lo lamento)/gi,
  banned: [
    'sinceramente lo sentimos', 'tomamos su comentario en serio', 'su comentario cuenta',
    'lamentamos profundamente', 'su sentimiento', 'con total transparencia',
    'inaceptable', 'no dude', 'gracias por tomarse el tiempo',
    'gracias por dedicarnos su tiempo', 'gracias por compartir su experiencia',
    'gracias por compartir', 'valoramos su comentario', 'apreciamos su comentario',
    'gracias por su valioso comentario', 'gracias por su valoración',
    'escuchamos su decepción', 'entendemos su decepción', 'esté seguro',
  ],
  impatience: /(impaciente|mala fe|deshonesto|exagera|usted exagera|exagerado)/i,
  internalClaims: [
    [/\bregistros?\b|\bapuntes?\b/i, 'registre'],
    [/\binspecciones?\b|\bcontroles?\b|\bverificamos\b/i, 'contrôle'],
    [/\bprocedimientos?\b|\bprotocolos?\b/i, 'procédure'],
    [/\bestamos trabajando (en|para)\b|\btrabajamos (en|para)\b/i, 'nous travaillons à'],
    [/\b(hemos )?(revisado|revisamos|reconsiderado)\b/i, 'nous revoyons'],
    [/\b(hemos )?(implementado|instaurado|puesto en (marcha|práctica))\b/i, 'nous mettons en place'],
  ],
  surprise: /\bsorprend|\bsorpresa\b/i,
  analysisLeak: /\b(naturaleza|categoría|tipo) de (la |su |esta )?(crítica|reseña|queja)\b|su (reseña|comentario|mensaje|opinión) (trata (de|sobre)|se refiere a|concierne|se centra en)/i,
  noDetail: /(sin (detalles|especificaciones)|no (da|aporta|deja) (ningún )?detalles?|sin explicación|reseña (vacía|sin texto)|comentario vacío|falta de detalles)/i,
  warned: /(usted (fue|había sido) (advertido|informado|avisado)|como (acordamos|convenimos|mencionamos|anunciamos)|(informado|avisado|advertido)[^.]{0,30}(a|en|antes de) (su |la )?(llegada|entrada|pedido))/i,
  factsHint: /(advertido|informado|avisado|anunciado|mencionado|acordado|convenido|previsto|planeado)/i,
  firstSentFact: /(advertido|avisado|informado|anunciado|casa llena|completo|lleno|aforo completo|estaba lleno)/i,
  blame: /(usted (fue|había sido) (advertido|avisado|informado)|le (habíamos|hemos) (advertido|avisado|informado)|como (le |le habíamos )?(dijimos|mencionamos|acordamos)|como convenido)/i,
  priceWords: /(precio|precios|coste|cuenta|factura|euro|€|rand|R\s?\d)/i,
  returnInvite: /(vuelva|volver|visítenos (de nuevo|otra vez)|le esperamos (de nuevo|pronto)|segunda oportunidad|otra oportunidad|próxima (visita|vez)|bienvenido|pase (a|por)|le recibiremos|cuando quiera|pronto)/i,
  commercialGesture: /(reembolso|gratis|descuento|cupón|regalo|compensación|compensar|le ofrecemos (gratis|una)|invitación|invitamos)/i,
  contactInvite: /(contacto|contactar|llamar|escribir|e-?mail|correo|teléfono|en privado|directamente|hablar (con|a)|comuníquese|póngase en contacto)/i,
  admission: /\b(nuestra culpa|nuestra responsabilidad|somos (los )?responsables|admitimos|reconocemos|intoxicación|le (hemos|causamos) (enferm|mal)|enfermó (por|en|con) nuestra)/i,
  closingFormulas: /atentamente|cordialmente|un saludo|saludos|mejores deseos|el equipo|cordiales saludos/i,
  triadAnd: ' y ',
  clauseMark: /\b(yo|tú|él|ella|ello|nosotros|vosotros|ellos|ellas|esto|eso|aquello|quien|cuando|como|porque|pues|donde|si|pero|así|ni|para|es|son|era|eran|está|están|ser|fue|fueron|será|seré|seremos|serán|sea|sean|había|hemos|habéis|han|habrá|voy|va|van|vamos|vengo|viene|vienen|espero|esperamos|quisiera|deseo|deseamos|invito|invitamos|veo|ven|siento|permanezco|parezco|merezco|espero)\b/i,
  reservation: /reserve (una|su) mesa|reservar (una|su) mesa|haga su reserva|reservar con antelación|haga (una )?reserva|reserve con tiempo/i,
};

const it: LangPack = {
  greeting: /^(buongiorno|buonasera|buona sera|salve|gentile|caro|cara|grazie)/i,
  greetingWord: 'Buongiorno',
  informal: /\b(tu|te|ti|tuo|tua|tuoi|tue|voi|vostro|vostra)\b/i, // formel : 'Lei'
  forbidden: /\b(bugiardo|bugiarda|bugia|mentisci|diffamazione|diffamatorio|tribunale|causa|avvocato|via legale|procedimento|denuncia|polizia|querela|citare in giudizio|azione legale)\b/i,
  apology: /(\b(ci siamo|ci dispiace|siamo dispiaciuti|siamo (veramente |davvero |sinceramente )?(dispiaciuti|spiacenti))|le (presentiamo|porgiamo) (le nostre |sincere )?(scuse|scusanti)|le nostre (più sincere )?scuse|ci scusiamo|chiediamo scusa|scusi|scusate|mi scuso|mi rincresce)/gi,
  banned: [
    'sinceramente spiacente', 'prendiamo il suo feedback sul serio', 'il suo feedback conta',
    'siamo profondamente dispiaciuti', 'il suo sentimento', 'in piena trasparenza',
    'inaccettabile', 'non esiti', 'grazie per aver dedicato del tempo',
    'grazie per averci dedicato del tempo', 'grazie per aver condiviso la sua esperienza',
    'grazie per aver condiviso', 'apprezziamo il suo feedback',
    'grazie per il suo prezioso feedback', 'grazie per la sua recensione',
    'sentiamo la sua delusione', 'comprendiamo la sua delusione', 'stia certo',
  ],
  impatience: /(impaziente|malafede|disonesto|esagera|lei esagera|esagerato)/i,
  internalClaims: [
    [/\bregistri\b|\bregistro\b/i, 'registre'],
    [/\bispezioni\b|\bcontrolli\b|\bverifichiamo\b/i, 'contrôle'],
    [/\bprocedure\b|\bprotocolli\b/i, 'procédure'],
    [/\bstiamo lavorando (a|per)\b|\blavoriamo (a|per)\b/i, 'nous travaillons à'],
    [/\b(abbiamo )?(rivisto|riesaminato|riveduto)\b/i, 'nous revoyons'],
    [/\b(abbiamo )?(implementato|messo in atto|istituito|adottato)\b/i, 'nous mettons en place'],
  ],
  surprise: /\bsorpres|\bsorpresa\b/i,
  analysisLeak: /\b(natura|categoria|tipo) della (critica|recensione|lamentela)\b|la sua (recensione|commento|messaggio|opinione) (riguarda|tratta|si concentra su|è in merito a)/i,
  noDetail: /(nessun dettaglio|senza (alcun )?dettaglio|non (dà|fornisce|lascia) (alcun )?dettaglio|senza spiegazione|recensione (vuota|senza testo)|commento vuoto|mancanza di dettagli)/i,
  warned: /(era stato (avvisato|informato|avvertito)|come (concordato|concordemente|menzionato|annunciato)|(informato|avvisato|avvertito)[^.]{0,30}(al|alla|prima del) (suo |della )?(arrivo|ingresso|ordine))/i,
  factsHint: /(avvisato|informato|avvertito|annunciato|menzionato|concordato|previsto|pianificato)/i,
  firstSentFact: /(avvisato|informato|annunciato|sala piena|completo|tutto esaurito|era pieno|al completo)/i,
  blame: /(era stato (avvisato|avvertito|informato)|le (avevamo|abbiamo) (avvisato|avvertito|informato)|come (le |le avevamo )?(detto|menzionato|concordato)|come concordato)/i,
  priceWords: /(prezzo|prezzi|costo|conto|fattura|euro|€|rand|R\s?\d)/i,
  returnInvite: /(torni|tornare|ci visiti (di nuovo|ancora)|la aspettiamo (di nuovo|presto)|seconda possibilità|altra possibilità|prossima (visita|volta)|benvenuto|passi (a|da)|la accoglieremo|quando vuole|presto|a presto)/i,
  commercialGesture: /(rimborso|gratis|sconto|buono|regalo|compensazione|compensare|le offriamo (gratis|un)|omaggio|offriamo)/i,
  contactInvite: /(contatto|contattarci|chiamare|scrivere|e-?mail|telefono|in privato|direttamente|parlare (con|a)|ci contatti|si metta in contatto)/i,
  admission: /\b(nostra colpa|nostra responsabilità|siamo (i )?responsabili|ammettiamo|riconosciamo|intossicazione|l'(abbiamo|ha) (fatta|fatta star|fatta sentire) (male|star male))/i,
  closingFormulas: /cordiali saluti|distinti saluti|cordialmente|saluti|i migliori auguri|il team|un caro saluto/i,
  triadAnd: ' e ',
  clauseMark: /\b(io|tu|lui|lei|esso|noi|voi|loro|questo|quello|chi|quando|come|perché|poiché|dove|se|ma|così|né|per|è|sono|era|erano|essere|fu|furono|sarà|sarò|saremo|saranno|sia|siano|avevo|aveva|avevano|abbiamo|avete|hanno|avrò|vado|va|vanno|andiamo|vengo|viene|vengono|spero|speriamo|vorrei|desidero|desideriamo|invito|invitiamo|vedo|vedono|sento|resto|sembr|merit|aspett)\b/i,
  reservation: /prenoti (un|il) tavolo|prenotare (un|il) tavolo|fare una prenotazione|prenotare in anticipo|prenoti in anticipo|prenotazione anticipata/i,
};

const sw: LangPack = {
  greeting: /^(habari|jambo|hujambo|karibu|asante|mambo|niaje)/i,
  greetingWord: 'Habari',
  informal: null, // pas de distinction tu/vous en swahili standard
  forbidden: /\b(mwongo|uongo|kiniga|kesi|wakili|mahakamani|polisi|hatua ya kisheria|fidia ya kisheria)\b/i,
  apology: /(pole sana|tunasikitika|nasikitika sana|samahani sana|tunaomba msamaha|nasikitika)/gi,
  banned: [
    'tunathamini maoni yako', 'asante kwa maoni yako', 'maoni yako ni muhimu',
    'asante kwa kutoa muda', 'asante kwa muda wako', 'pole sana sana',
    'tunasikiliza', 'usisite kuwasiliana', 'hakuna shaka', 'ukishangaa',
    'tunaheshimu', 'pole kwa', 'asante kwa kutueleza', 'tunajali hisia zako',
  ],
  impatience: /(upuzi|ukaidi|uongo|huongea uongo|kupiga moyo|kukosha|siyo kweli)/i,
  internalClaims: [
    [/\brekodi\b/i, 'registre'],
    [/\bukaguzi\b|\bkagua\b|\btunakagua\b/i, 'contrôle'],
    [/\btaratibu\b|\btaratibu\s/i, 'procédure'],
    [/\btunafanya kazi\b|\btunajitahidi\b/i, 'nous travaillons à'],
    [/\btumefanya mabadiliko\b|\btunaweka mapya\b/i, 'nous mettons en place'],
  ],
  surprise: /\b(tunashangaa|nashangaa|kunishangaza|kushangaza)\b/i,
  analysisLeak: /\b(aina|jamii) ya (malalamiko|lalamiko|maoni)\b|maoni (yako|haya) (yanahusu|yanangalia)/i,
  noDetail: /(hakuna maelezo|bila maelezo|hayana maelezo|maelezo machache)/i,
  warned: /(uli(wa)?onywa|tulikuonya|tulikujulisha|kama tulivyokubaliana|kama ilivyotajwa|tulikuambia)/i,
  factsHint: /(kuliwaonya|onywa|julishwa|kubaliana|tulikuambia|kama ilivyosemekana)/i,
  firstSentFact: /(tulikuonya|tulikujulisha|tulikuambia|zimejaa|meza zilikuwa zimejaa)/i,
  blame: /(tulikuambia|kama tulivyosema|tulikuonya|kama tulivyokubaliana|ulivyosema)/i,
  priceWords: /(bei|gharama|shilingi|kes|bili|malipo|nafuu|ghali|pesa)/i,
  returnInvite: /(karibu tena|njoo tena|rudi tena|tunakukaribisha|tutaonana|mara nyingine|tutakusubiri|karibu sana)/i,
  commercialGesture: /(punguzo|zawadi|bure|fidia|rudisha pesa|rudishi|koponi|offers|mbili kwa moja)/i,
  contactInvite: /(wasiliana|piga simu|tutumie|andika|barua pepe|binafsi|moja kwa moja)/i,
  admission: /\b(kosa letu|tunakubali makosa|ni hatia yetu|tuna jukumu|uozo wa chakula|ugonjwa kutoka)\b/i,
  closingFormulas: /kwa heshima|heri ya|salamu zangu|baraka|kwa salamu|kwa heshima kubwa|tuko tayari/i,
  triadAnd: ' na ',
  clauseMark: /\b(ni|na|ya|wa|la|za|kwa|kwenye|wewe|mimi|sisi|ninyi|yeye|huu|hii|hiyo|lakini|au|kama|tuna|una|ana|tena|pia|tu|kila|hapa|ilikuwa|itakuwa|ilikuwepo|nili|tuli|wame)\b/i,
  reservation: /(hifadhi (meza|nafasi)|kata meza|meza mapema|hifadhi mapema|kata nafasi)/i,
};

export const LANG_PACKS: Record<Exclude<ReplyLang, 'fr'>, LangPack> = { en, af, de, nl, es, it, sw };
