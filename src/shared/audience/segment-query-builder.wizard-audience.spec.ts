import { SegmentQueryBuilderService, SegmentQuery } from './segment-query-builder.service';
import { Segment } from '../../modules/segments/entities/segment.entity';
import { TenantDbContext } from '../../evo-extension-points';
import { AudienceConfigError } from './errors/audience.errors';

// The campaign wizard saves the audience as `segment_ids` / `tag_ids` inside
// `steps.wizard_state` (a leading "!" means exclude). Before this was read, such a campaign
// fell through to the "all contacts" default and was sent to the whole base.
describe('SegmentQueryBuilderService - audience chosen in the campaign wizard', () => {
  const segmentRepository: any = {};
  const taggingRepository: any = {};
  const db = {
    getRepository: (entity: unknown) =>
      entity === Segment ? segmentRepository : taggingRepository,
  } as unknown as TenantDbContext;
  const contactsClient = { getLabelTitle: jest.fn(), listAllIds: jest.fn() };
  // Segment membership lives in ClickHouse, behind SegmentComputationService.
  const segmentComputation = { getContactIdsInSegments: jest.fn() };
  const service = new SegmentQueryBuilderService(
    db,
    contactsClient as any,
    segmentComputation as any,
  );

  const campaign = (overrides: Record<string, unknown> = {}): any => ({
    id: 'camp-1',
    sendToAll: false,
    triggerConfig: null,
    steps: null,
    tags: [],
    query: null,
    ...overrides,
  });

  const wizardSteps = (state: Record<string, unknown>) => ({ wizard_state: state });

  beforeEach(() => {
    segmentComputation.getContactIdsInSegments.mockReset();
    contactsClient.getLabelTitle.mockReset().mockResolvedValue(null);
    contactsClient.listAllIds.mockReset();
  });

  describe('analyzeSegmentationStrategy', () => {
    it('targets the selected segments instead of everyone', async () => {
      const result = await service.analyzeSegmentationStrategy(
        campaign({ steps: wizardSteps({ contact_selection: 'segments', segment_ids: ['seg-a', 'seg-b'] }) }),
      );

      expect(result).toEqual({
        type: 'segments',
        includeSegmentIds: ['seg-a', 'seg-b'],
        excludeSegmentIds: [],
      });
    });

    it('treats ids with a leading "!" as exclusions', async () => {
      const result = await service.analyzeSegmentationStrategy(
        campaign({ steps: wizardSteps({ contact_selection: 'segments', segment_ids: ['seg-a', '!seg-x'] }) }),
      );

      expect(result).toEqual({ type: 'segments', includeSegmentIds: ['seg-a'], excludeSegmentIds: ['seg-x'] });
    });

    it('reads the audience from audience_state or steps when wizard_state lacks it', async () => {
      const fromAudienceState = await service.analyzeSegmentationStrategy(
        campaign({ steps: { audience_state: { contact_selection: 'segments', segment_ids: ['seg-a'] } } }),
      );
      const fromSteps = await service.analyzeSegmentationStrategy(
        campaign({ steps: { contact_selection: 'segments', segment_ids: ['seg-b'] } }),
      );

      expect(fromAudienceState).toMatchObject({ type: 'segments', includeSegmentIds: ['seg-a'] });
      expect(fromSteps).toMatchObject({ type: 'segments', includeSegmentIds: ['seg-b'] });
    });

    it('refuses to send to everyone when segments were chosen but none can be included', async () => {
      await expect(
        service.analyzeSegmentationStrategy(
          campaign({ steps: wizardSteps({ contact_selection: 'segments', segment_ids: [] }) }),
        ),
      ).rejects.toBeInstanceOf(AudienceConfigError);

      await expect(
        service.analyzeSegmentationStrategy(
          campaign({ steps: wizardSteps({ contact_selection: 'segments', segment_ids: ['!seg-x'] }) }),
        ),
      ).rejects.toBeInstanceOf(AudienceConfigError);
    });

    it('refuses segments combined with tags, which is not supported yet', async () => {
      await expect(
        service.analyzeSegmentationStrategy(
          campaign({
            steps: wizardSteps({ contact_selection: 'segments', segment_ids: ['seg-a'], tag_ids: ['tag-1'] }),
          }),
        ),
      ).rejects.toBeInstanceOf(AudienceConfigError);
    });

    it('refuses a tags audience that cannot be resolved instead of defaulting to everyone', async () => {
      await expect(
        service.analyzeSegmentationStrategy(
          campaign({ steps: wizardSteps({ contact_selection: 'tags', tag_ids: ['tag-1'] }) }),
        ),
      ).rejects.toBeInstanceOf(AudienceConfigError);
    });

    it('resolves the label ids chosen in the wizard to tag names', async () => {
      const titles: Record<string, string> = { 'tag-1': 'vip', 'tag-2': 'lead-quente' };
      contactsClient.getLabelTitle.mockImplementation(async (id: string) => titles[id] ?? null);

      const result = await service.analyzeSegmentationStrategy(
        campaign({ steps: wizardSteps({ contact_selection: 'tags', tag_ids: ['tag-1', 'tag-2', 'tag-1'] }) }),
      );

      expect(result).toEqual({ type: 'tags', tags: ['vip', 'lead-quente'] });
    });

    it('refuses when a chosen label no longer exists instead of narrowing silently', async () => {
      contactsClient.getLabelTitle.mockImplementation(async (id: string) => (id === 'tag-1' ? 'vip' : null));

      await expect(
        service.analyzeSegmentationStrategy(
          campaign({ steps: wizardSteps({ contact_selection: 'tags', tag_ids: ['tag-1', 'tag-gone'] }) }),
        ),
      ).rejects.toBeInstanceOf(AudienceConfigError);
    });

    it('refuses excluded labels, which the tag lookup cannot honor yet', async () => {
      await expect(
        service.analyzeSegmentationStrategy(
          campaign({ steps: wizardSteps({ contact_selection: 'tags', tag_ids: ['tag-1', '!tag-2'] }) }),
        ),
      ).rejects.toBeInstanceOf(AudienceConfigError);
      expect(contactsClient.getLabelTitle).not.toHaveBeenCalled();
    });

    it('still resolves a tags audience when the campaign carries the tag names', async () => {
      const result = await service.analyzeSegmentationStrategy(
        campaign({ tags: ['vip'], steps: wizardSteps({ contact_selection: 'tags', tag_ids: ['tag-1'] }) }),
      );

      expect(result).toEqual({ type: 'tags', tags: ['vip'] });
    });

    it('keeps the previous behavior when the wizard did not restrict the audience', async () => {
      expect(await service.analyzeSegmentationStrategy(campaign())).toEqual({ type: 'all' });
      expect(
        await service.analyzeSegmentationStrategy(
          campaign({ steps: wizardSteps({ contact_selection: 'all', segment_ids: [] }) }),
        ),
      ).toEqual({ type: 'all' });
    });

    it('keeps sendToAll and the trigger segment ahead of the wizard audience', async () => {
      const steps = wizardSteps({ contact_selection: 'segments', segment_ids: ['seg-wizard'] });

      expect(await service.analyzeSegmentationStrategy(campaign({ sendToAll: true, steps }))).toEqual({
        type: 'all',
      });
      expect(
        await service.analyzeSegmentationStrategy(campaign({ triggerConfig: { segment_id: 'seg-trigger' }, steps })),
      ).toEqual({ type: 'segment', segmentId: 'seg-trigger' });
    });

    it('ignores malformed wizard data', async () => {
      const result = await service.analyzeSegmentationStrategy(
        campaign({ steps: wizardSteps({ contact_selection: 'segments', segment_ids: ['seg-a', 7, null, ''] }) }),
      );

      expect(result).toMatchObject({ type: 'segments', includeSegmentIds: ['seg-a'] });
    });
  });

  describe('fixed list of contacts', () => {
    it('targets exactly the saved contacts, without duplicates', async () => {
      const result = await service.analyzeSegmentationStrategy(
        campaign({ steps: wizardSteps({ contact_selection: 'contacts', contact_ids: ['c1', 'c2', 'c1'] }) }),
      );

      expect(result).toEqual({ type: 'contacts', contactIds: ['c1', 'c2'] });
    });

    it('refuses an empty list instead of defaulting to everyone', async () => {
      await expect(
        service.analyzeSegmentationStrategy(
          campaign({ steps: wizardSteps({ contact_selection: 'contacts', contact_ids: [] }) }),
        ),
      ).rejects.toBeInstanceOf(AudienceConfigError);
    });

    it('returns the list paginated with the full total', async () => {
      const query: SegmentQuery = { type: 'contacts', contactIds: ['c1', 'c2', 'c3'] };

      const page = await service.executeAudienceQuery(campaign(), query, 2, 1);
      const all = await service.executeAudienceQuery(campaign(), query);

      expect(page.contactIds).toEqual(['c2', 'c3']);
      expect(page.total).toBe(3);
      expect(all.contactIds).toEqual(['c1', 'c2', 'c3']);
    });
  });

  describe('executeAudienceQuery with tags', () => {
    it('asks the CRM for the contacts carrying the labels, without duplicates', async () => {
      contactsClient.listAllIds.mockResolvedValue([
        { id: 'c1', blocked: false },
        { id: 'c2', blocked: false },
        { id: 'c1', blocked: false },
      ]);

      const result = await service.executeAudienceQuery(campaign(), { type: 'tags', tags: ['vip'] });

      expect(contactsClient.listAllIds).toHaveBeenCalledWith({ labels: ['vip'] });
      expect(result.contactIds).toEqual(['c1', 'c2']);
      expect(result.total).toBe(2);
    });
  });

  describe('executeAudienceQuery with segments', () => {
    const query = (include: string[], exclude: string[] = []) =>
      ({ type: 'segments', includeSegmentIds: include, excludeSegmentIds: exclude }) as const;

    it('asks ClickHouse for the contacts of the included segments', async () => {
      segmentComputation.getContactIdsInSegments.mockResolvedValue(['c1', 'c2', 'c3']);

      const result = await service.executeAudienceQuery(campaign(), query(['seg-a', 'seg-b']));

      expect(segmentComputation.getContactIdsInSegments).toHaveBeenCalledWith(['seg-a', 'seg-b'], []);
      expect(result.contactIds).toEqual(['c1', 'c2', 'c3']);
      expect(result.total).toBe(3);
    });

    it('passes the excluded segments along', async () => {
      segmentComputation.getContactIdsInSegments.mockResolvedValue(['c1']);

      await service.executeAudienceQuery(campaign(), query(['seg-a'], ['seg-x']));

      expect(segmentComputation.getContactIdsInSegments).toHaveBeenCalledWith(['seg-a'], ['seg-x']);
    });

    it('paginates in memory but keeps the full total', async () => {
      segmentComputation.getContactIdsInSegments.mockResolvedValue(['c1', 'c2', 'c3']);

      const result = await service.executeAudienceQuery(campaign(), query(['seg-a']), 2, 1);

      expect(result.contactIds).toEqual(['c2', 'c3']);
      expect(result.total).toBe(3);
    });

    it('does not hide a ClickHouse failure behind an empty audience', async () => {
      segmentComputation.getContactIdsInSegments.mockRejectedValue(new Error('clickhouse down'));

      await expect(service.executeAudienceQuery(campaign(), query(['seg-a']))).rejects.toThrow('clickhouse down');
    });
  });
});
