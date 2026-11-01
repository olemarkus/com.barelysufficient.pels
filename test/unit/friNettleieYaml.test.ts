import { parseFriNettleieYaml } from '../../lib/price/friNettleieYaml';

describe('parseFriNettleieYaml', () => {
  it('reads the shapes a Fri Nettleie tariff file uses', () => {
    const source = `---
# A comment line
netteier: 'Test Nett AS' # trailing comment
gln:
  - '7080005046220'
sist_oppdatert: '2026-06-05'
kilder:
  - https://example.no/priser#anker
tariffer:
  - kundegrupper:
      - husholdning
      - fritid
    fastledd:
      metode: TRE_DØGNMAX_MND
      terskel_inkludert: true
      terskler:
        - terskel: 0
          pris: 1296
    energiledd:
      grunnpris: 16.99
      unntak:
        - navn: 'Virkedag'
          timer: 6-21
          dager: [virkedag, 'helg']
          pris: -2.5
    gyldig_fra: '2026-07-01'
    gyldig_til:
`;
    expect(parseFriNettleieYaml(source)).toEqual({
      netteier: 'Test Nett AS',
      gln: ['7080005046220'],
      sist_oppdatert: '2026-06-05',
      kilder: ['https://example.no/priser#anker'],
      tariffer: [{
        kundegrupper: ['husholdning', 'fritid'],
        fastledd: { metode: 'TRE_DØGNMAX_MND', terskel_inkludert: true, terskler: [{ terskel: 0, pris: 1296 }] },
        energiledd: {
          grunnpris: 16.99,
          unntak: [{ navn: 'Virkedag', timer: '6-21', dager: ['virkedag', 'helg'], pris: -2.5 }],
        },
        gyldig_fra: '2026-07-01',
        gyldig_til: null,
      }],
    });
  });

  it("reads a list sitting at its key's indent", () => {
    expect(parseFriNettleieYaml('gln:\n- \'1\'\n- \'2\'\nnavn: x\n')).toEqual({ gln: ['1', '2'], navn: 'x' });
  });

  it('rejects YAML outside the subset rather than misreading it', () => {
    expect(() => parseFriNettleieYaml('tariffer: {flow: map}')).toThrow();
    expect(() => parseFriNettleieYaml('base: &anchor 1\ncopy: *anchor')).toThrow();
    expect(() => parseFriNettleieYaml("navn: 'unterminated")).toThrow();
    expect(() => parseFriNettleieYaml('tekst: |\n  linje')).toThrow();
  });
});
