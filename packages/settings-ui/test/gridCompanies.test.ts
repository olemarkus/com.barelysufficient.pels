import { describe, expect, it } from 'vitest';
import {
  gridCompanies,
  gridCompaniesForCounty,
  gridCompanyNameOf,
  retiredGridCompanies,
} from '../src/ui/gridCompanies.ts';

const HEMSIL = '923050612';
const FOIE = '971589752';

describe('gridCompaniesForCounty', () => {
  it('offers only operating companies to an owner who has not chosen a retired one', () => {
    const offered = gridCompaniesForCounty('33', FOIE).map((company) => company.organizationNumber);
    expect(offered).toContain(FOIE);
    expect(offered).not.toContain(HEMSIL);
  });

  it('keeps a saved retired company in its county so the saved choice still shows', () => {
    const offered = gridCompaniesForCounty('33', HEMSIL);
    expect(offered.find((company) => company.organizationNumber === HEMSIL)?.name)
      .toBe('FØIE AS (formerly Hemsil Nett)');
    expect(gridCompaniesForCounty('46', HEMSIL).some((company) => company.organizationNumber === HEMSIL))
      .toBe(false);
  });

  it('lists no company as both operating and retired', () => {
    const operating = new Set(gridCompanies.map((company) => company.organizationNumber));
    expect(retiredGridCompanies.filter((company) => operating.has(company.organizationNumber))).toEqual([]);
  });
});

describe('gridCompanyNameOf', () => {
  it('names an operating, a retired and an unknown company', () => {
    expect(gridCompanyNameOf(FOIE)).toBe('FØIE AS');
    expect(gridCompanyNameOf(HEMSIL)).toBe('FØIE AS (formerly Hemsil Nett)');
    expect(gridCompanyNameOf('000000000')).toBeUndefined();
  });
});
