import { runCloudBackup, runIfDue } from '../src/dashboard/api-operations';

void runCloudBackup({ trigger: 'manual', password: null });
// @ts-expect-error the public trigger is limited to manual and scheduled
void runCloudBackup({ trigger: 'automated' });
// @ts-expect-error passwords are text or null
void runCloudBackup({ password: 7 });

void runIfDue({ now: '2026-10-03T00:00:00.000Z' }).then((result) => {
  if (result.ran) {
    const ran: true = result.ran;
    void ran;
    // @ts-expect-error scheduled-run results have no misspelled property
    void result.misspelled;
  } else {
    const notRan: false = result.ran;
    void notRan;
  }
});
// @ts-expect-error scheduler time is an ISO string or null
void runIfDue({ now: 7 });
