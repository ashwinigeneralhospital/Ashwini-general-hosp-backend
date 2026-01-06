import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import { env } from '../src/config/env.js';

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const createAdminUser = async () => {
  try {
    console.log('🔐 Creating admin user with direct authentication...');

    const adminEmail = env.SEED_ADMIN_EMAIL;
    const adminPassword = env.SEED_ADMIN_PASSWORD;
    const adminName = env.SEED_ADMIN_NAME;

    if (!adminEmail || !adminPassword || !adminName) {
      throw new Error('Missing admin credentials in environment variables');
    }

    const [firstName, ...rest] = adminName.split(' ').filter(Boolean);
    const lastName = rest.join(' ');
    const resolvedFirstName = firstName || adminEmail.split('@')[0];
    const resolvedLastName = lastName || 'Admin';

    // Hash the password
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(adminPassword, saltRounds);

    // Check if admin already exists
    const { data: existingAdmin, error: fetchError } = await supabase
      .from('staff')
      .select('id, email')
      .eq('email', adminEmail)
      .maybeSingle();

    if (fetchError) {
      throw fetchError;
    }

    if (existingAdmin) {
      console.log('🔄 Updating existing admin with password hash...');
      
      const { error: updateError } = await supabase
        .from('staff')
        .update({
          password_hash: passwordHash,
          updated_at: new Date().toISOString()
        })
        .eq('id', existingAdmin.id);

      if (updateError) {
        throw updateError;
      }

      console.log('✅ Admin user updated successfully!');
    } else {
      console.log('🆕 Creating new admin user...');

      const { error: insertError } = await supabase
        .from('staff')
        .insert({
          first_name: resolvedFirstName,
          last_name: resolvedLastName,
          email: adminEmail,
          role: 'admin',
          employment_role: 'Administrator',
          employment_status: 'active',
          department: 'Administration',
          phone: '+91-9000000000',
          is_active: true,
          password_hash: passwordHash,
          requires_password_reset: false
        });

      if (insertError) {
        throw insertError;
      }

      console.log('✅ Admin user created successfully!');
    }

    console.log(`📧 Email: ${adminEmail}`);
    console.log(`🔑 Password: ${adminPassword}`);
    console.log('🎉 Direct authentication setup complete!');
    
  } catch (error) {
    console.error('❌ Failed to create admin user:', error);
    process.exit(1);
  }
};

createAdminUser();
