import { SegmentComputationService } from './segment-computation.service';

// Campaign audiences made of several segments (include some, exclude others) are read
// from ClickHouse, where segment membership is stored, with the same FINAL semantics as
// getSegmentContacts.
describe('SegmentComputationService.getContactIdsInSegments', () => {
  function buildService(rows: Array<{ contact_id: string }> = []) {
    const added: Array<{ value: unknown; type: string }> = [];
    const clickhouseService = {
      createQueryBuilder: () => ({
        addParameter: (value: unknown, type: string) => {
          added.push({ value, type });
          return `{param_${added.length - 1}:${type}}`;
        },
        build: () => ({
          parameters: Object.fromEntries(
            added.map((entry, index) => [`param_${index}`, entry.value]),
          ),
        }),
      }),
      query: jest.fn().mockResolvedValue(rows),
    };

    const service = new SegmentComputationService(
      {} as any, // TenantDbContext
      {} as any, // ModularSegmentComputationService
      clickhouseService as any, // ClickHouseService
      {} as any, // SegmentCacheService
      { emit: () => undefined } as any, // EventEmitter2
    );
    return { service, clickhouseService, added };
  }

  const sent = (clickhouseService: { query: jest.Mock }) =>
    clickhouseService.query.mock.calls[0][0] as {
      query: string;
      parameters: Record<string, unknown>;
    };

  it('returns the contact ids of the included segments', async () => {
    const { service } = buildService([
      { contact_id: 'c1' },
      { contact_id: 'c2' },
    ]);

    await expect(
      service.getContactIdsInSegments(['seg-a', 'seg-b']),
    ).resolves.toEqual(['c1', 'c2']);
  });

  it('reads the ClickHouse assignment table with FINAL and passes ids as an array parameter', async () => {
    const { service, clickhouseService } = buildService();

    await service.getContactIdsInSegments(['seg-a', 'seg-b']);

    const { query, parameters } = sent(clickhouseService);
    expect(query).toContain('computed_property_assignments_v2 FINAL');
    expect(query).toContain("type = 'segment'");
    expect(query).toContain('segment_value = true');
    expect(query).toContain('computed_property_id IN {param_0:Array(String)}');
    expect(parameters).toEqual({ param_0: ['seg-a', 'seg-b'] });
    expect(query).not.toContain('NOT IN');
  });

  it('subtracts the excluded segments with a second array parameter', async () => {
    const { service, clickhouseService } = buildService();

    await service.getContactIdsInSegments(['seg-a'], ['seg-x', 'seg-y']);

    const { query, parameters } = sent(clickhouseService);
    expect(query).toContain('contact_id NOT IN (');
    expect(query).toContain('computed_property_id IN {param_1:Array(String)}');
    expect(parameters).toEqual({
      param_0: ['seg-a'],
      param_1: ['seg-x', 'seg-y'],
    });
  });

  it('never puts segment ids in the SQL text', async () => {
    const { service, clickhouseService } = buildService();

    await service.getContactIdsInSegments(["x'; DROP TABLE y;--"]);

    expect(sent(clickhouseService).query).not.toContain('DROP TABLE');
  });

  it('returns an empty list without querying when there is no segment to include', async () => {
    const { service, clickhouseService } = buildService();

    await expect(service.getContactIdsInSegments([], ['seg-x'])).resolves.toEqual([]);
    expect(clickhouseService.query).not.toHaveBeenCalled();
  });

  it('rejects instead of returning an empty audience when ClickHouse fails', async () => {
    const { service, clickhouseService } = buildService();
    clickhouseService.query.mockRejectedValue(new Error('ClickHouse down'));

    await expect(service.getContactIdsInSegments(['seg-a'])).rejects.toThrow(
      'ClickHouse down',
    );
  });
});
