import base from '@himynameisdave/oxfmt-config/base';
import { defineConfig } from 'oxfmt';

export default defineConfig({ ...base, ignorePatterns: ['dist/**', 'package-lock.json'] });
