import { validateSync } from 'class-validator';
import { CreateUserDto, PLANTS_AI_MODULE_SLUG } from './create-user.dto';

describe('CreateUserDto', () => {
  it('accepts the plantsAi module slug', () => {
    const dto = Object.assign(new CreateUserDto(), {
      name: 'Tester',
      username: 'tester.ai',
      password: 'secret1',
      allowedModules: [PLANTS_AI_MODULE_SLUG],
    });

    const errors = validateSync(dto);

    expect(errors).toHaveLength(0);
  });
});
