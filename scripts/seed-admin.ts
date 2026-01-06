import { createClient } from '@supabase/supabase-js';
import { env } from '../src/config/env.js';

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const seedAdmin = async () => {
  try {
    console.log('🔐 Checking for existing admin in staff table...');

    const { data: existingAdmin, error: fetchError } = await supabase
      .from('staff')
      .select('id')
      .eq('role', 'admin')
      .limit(1)
      .maybeSingle();

    if (fetchError) {
      throw fetchError;
    }

    if (existingAdmin) {
      console.log('✅ Admin already exists. Skipping creation.');
      process.exit(0);
    }

    console.log('🆕 Creating admin auth user in Supabase...');

    const { data: authUser, error: createUserError } = await supabase.auth.admin.createUser({
      email: env.SEED_ADMIN_EMAIL,
      password: env.SEED_ADMIN_PASSWORD,
      email_confirm: true,
    });

    if (createUserError || !authUser?.user) {
      throw createUserError || new Error('Failed to create Supabase auth user');
    }

    console.log('🧾 Storing staff profile...');

    const { error: staffError } = await supabase.from('staff').insert([
      {
        user_id: authUser.user.id,
        name: env.SEED_ADMIN_NAME,
        role: 'admin',
        department: 'Administration',
        phone: '+91-9000000000',
        is_active: true,
      },
    ]);

    if (staffError) {
      throw staffError;
    }

    console.log('🎉 Admin user created successfully!');
    console.log(`    Email: ${env.SEED_ADMIN_EMAIL}`);
    console.log(`    Password: ${env.SEED_ADMIN_PASSWORD}`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to seed admin user:', error);
    process.exit(1);
  }
};

seedAdmin();
