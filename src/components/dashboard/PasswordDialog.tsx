import { KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useApp } from '@/dashboard/store';
import { submitPassword, closePassword } from '@/dashboard/logic';
import { useEffect, useState } from 'react';

export function PasswordDialog() {
  const state = useApp();
  const { password } = state;
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const isNew = password.mode === 'new';

  useEffect(() => {
    if (password.open) {
      setPw1('');
      setPw2('');
    }
  }, [password.open, password.mode]);

  return (
    <Dialog
      open={password.open}
      onOpenChange={(open) => {
        if (!open) closePassword(null);
      }}
    >
      <DialogContent id="section-password" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" />
            {isNew ? 'Choose an encryption password' : 'Backup password'}
          </DialogTitle>
          <DialogDescription>
            {isNew
              ? 'The password never leaves this machine, is never stored and never logged. If you lose it, the backup cannot be recovered. Minimum 8 characters recommended.'
              : 'Enter the password this backup was encrypted with.'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Label htmlFor="pw1">
            New password
            <Input
              id="pw1"
              type="password"
              autoComplete="new-password"
              value={pw1}
              onChange={(e) => setPw1(e.target.value)}
              autoFocus
            />
          </Label>
          {isNew && (
            <Label htmlFor="pw2">
              Confirm password
              <Input
                id="pw2"
                type="password"
                autoComplete="new-password"
                value={pw2}
                onChange={(e) => setPw2(e.target.value)}
              />
            </Label>
          )}
          <div id="pw-error" className="text-destructive text-sm">
            {password.error}
          </div>
        </div>
        <DialogFooter>
          <Button id="pw-ok" onClick={() => submitPassword(pw1, pw2)}>
            Continue
          </Button>
          <Button id="pw-cancel" variant="outline" onClick={() => closePassword(null)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
